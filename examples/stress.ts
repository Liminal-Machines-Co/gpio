// Fully-fledged stress test: many pins, mixed workloads, running concurrently
// for a sustained period while heap drift is reported. Complements
// soak-write.ts (single-pin fire-and-forget) by exercising the rest of the
// native machinery:
//
//   - fire-and-forget writes on several output pins   (async-work path)
//   - edge listeners on several input pins            (poll thread + TSFN)
//   - periodic reads on the input pins                (async-work path)
//   - mount/release churn: pins are released and re-requested, and inputs
//     reconfigured in place                           (fd lifecycle, poll-set
//                                                      rebuild, setConfig)
//
//   bun examples/stress.ts                            # real chip (Linux)
//   GPIO_MOCK=1 bun examples/stress.ts                # hardware-free smoke run
//   OUT_PINS=17,22 IN_PINS=5,6 STRESS_MS=600000 bun examples/stress.ts
//
// On real hardware, edge events only fire if the input pins see transitions —
// jumper an output to an input (the hardware-suite loopback) for full
// coverage. Churn errors ("not configured…") are expected: writes race the
// churn loop on purpose. Heap must plateau; a steady climb is a leak.
// In your own project the import is:  import { Gpio } from "@liminal-machines-co/gpio";
import { Gpio, MockGpio, type MockPin } from "../src/index.js";
import type { IPin } from "../src/types.js";

function parsePins(env: string | undefined, fallback: number[]): number[] {
	if (!env) return fallback;
	return env.split(",").map((s) => Number(s.trim()));
}

async function main() {
	const mock = Boolean(process.env.GPIO_MOCK);
	const outPins = parsePins(process.env.OUT_PINS, [17, 22, 23]);
	const inPins = parsePins(process.env.IN_PINS, [5, 6, 13]);
	const durationMs = Number(process.env.STRESS_MS ?? 5 * 60 * 1000);
	const writeMs = Number(process.env.INTERVAL_MS ?? 10);
	const churnMs = Number(process.env.CHURN_MS ?? 500);

	const gpio = mock ? new MockGpio() : new Gpio();

	const counters = {
		writes: 0,
		reads: 0,
		events: 0,
		churns: 0,
		writeErrors: 0,
		readErrors: 0,
		churnErrors: 0,
	};
	// Distinct error messages, counted — a wedged pin shows up as one message
	// repeating forever, a benign churn race as a small bounded count.
	const errorMessages = new Map<string, number>();
	const swallow = (kind: "writeErrors" | "readErrors" | "churnErrors") => {
		return (err: unknown) => {
			counters[kind]++;
			const msg = `${kind}: ${err instanceof Error ? err.message : String(err)}`;
			const n = (errorMessages.get(msg) ?? 0) + 1;
			errorMessages.set(msg, n);
			if (n === 1)
				console.log(
					`first occurrence @t=${Math.round((Date.now() - start) / 1000)}s — ${msg}`,
				);
		};
	};
	const start = Date.now();

	const setupInput = (pin: IPin) =>
		pin.setInput({
			pullup: true,
			edge: "both",
			onChange: () => {
				counters.events++;
			},
		});
	const setupOutput = (pin: IPin) => pin.setOutput({ initialValue: false });

	const outputs = outPins.map((bcm) => gpio.pin(bcm));
	const inputs = inPins.map((bcm) => gpio.pin(bcm));
	for (const pin of outputs) await setupOutput(pin);
	for (const pin of inputs) await setupInput(pin);

	console.log(
		`stress: outputs=[${outPins}] inputs=[${inPins}] for ${durationMs / 1000}s` +
			(mock ? " (mock)" : ""),
	);

	const timers: ReturnType<typeof setInterval>[] = [];

	// 1. fire-and-forget toggle per output pin (the incident workload, xN)
	let level = false;
	timers.push(
		setInterval(() => {
			level = !level;
			for (const pin of outputs) {
				counters.writes++;
				pin.write(level).catch(swallow("writeErrors"));
			}
		}, writeMs),
	);

	// 2. periodic awaited reads across all inputs
	timers.push(
		setInterval(() => {
			for (const pin of inputs) {
				counters.reads++;
				pin.read().catch(swallow("readErrors"));
			}
		}, 50),
	);

	// 3. mount/release churn: release + re-request one pin of each role, and
	//    reconfigure one input in place (setConfig path, poll-set rebuild)
	let churnTick = 0;
	let churning = false;
	timers.push(
		setInterval(() => {
			// never overlap churn bodies: overlapping release/setup on the same
			// pin would race in the script itself and muddy the library signal
			if (churning) return;
			churning = true;
			churnTick++;
			counters.churns++;
			const tick = churnTick;
			const out = outputs[tick % outputs.length];
			const inp = inputs[tick % inputs.length];
			(async () => {
				await out.release();
				await setupOutput(out);
				await inp.release();
				await setupInput(inp);
				// reconfigure in place: requested line, new config
				await setupInput(inputs[(tick + 1) % inputs.length]);
			})()
				.catch(swallow("churnErrors"))
				.finally(() => {
					churning = false;
				});
		}, churnMs),
	);

	// 4. mock only: drive the virtual inputs so edge listeners actually fire
	if (mock) {
		let mockLevel = false;
		timers.push(
			setInterval(() => {
				mockLevel = !mockLevel;
				for (const pin of inputs) (pin as MockPin).driveInput(mockLevel);
			}, 5),
		);
	}

	const baseline = process.memoryUsage().heapUsed;
	timers.push(
		setInterval(() => {
			if (globalThis.gc) globalThis.gc();
			const heap = process.memoryUsage().heapUsed;
			const drift = (heap - baseline) / 1024 / 1024;
			console.log(
				`t=${Math.round((Date.now() - start) / 1000)}s ` +
					`writes=${counters.writes} reads=${counters.reads} events=${counters.events} ` +
					`churns=${counters.churns} errors=${counters.writeErrors}w/${counters.readErrors}r/${counters.churnErrors}c ` +
					`heapUsed=${(heap / 1024 / 1024).toFixed(1)}MB (drift ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}MB)`,
			);
		}, 5000),
	);

	const stop = async () => {
		for (const t of timers) clearInterval(t);
		console.log(
			`done: writes=${counters.writes} reads=${counters.reads} events=${counters.events} ` +
				`churns=${counters.churns} ` +
				`errors=${counters.writeErrors}w/${counters.readErrors}r/${counters.churnErrors}c ` +
				`final heapUsed=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`,
		);
		for (const pin of [...outputs, ...inputs]) {
			console.log(`  pin ${pin.bcm}: direction=${pin.direction}`);
		}
		for (const [msg, n] of errorMessages) console.log(`  ${n}x ${msg}`);
		await gpio.release();
	};

	process.on("SIGINT", async () => {
		await stop();
		process.exit(0);
	});

	await new Promise((resolve) => setTimeout(resolve, durationMs));
	await stop();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
