// Soak test / leak repro: toggle one output pin fire-and-forget on a timer
// (the workload that produced a V8 heap OOM after ~13 min) and watch heapUsed.
// A healthy build plateaus; a leak climbs steadily.
//
//   bun examples/soak-write.ts 17                 # real chip (Linux)
//   GPIO_MOCK=1 bun examples/soak-write.ts        # hardware-free smoke run
//   SOAK_MS=300000 SNAPSHOTS=1 bun examples/soak-write.ts 17
//
// SNAPSHOTS=1 writes two V8 heap snapshots (60 s apart) next to the script;
// diff them in Chrome DevTools to name the dominant retained class.
// In your own project the import is:  import { Gpio } from "@liminal-machines-co/gpio";
import { writeHeapSnapshot } from "node:v8";
import { Gpio, MockGpio } from "../src/index.js";

async function main() {
	const bcm = Number(process.argv[2] ?? process.env.GPIO_PIN ?? 17);
	const durationMs = Number(process.env.SOAK_MS ?? 5 * 60 * 1000);
	const intervalMs = Number(process.env.INTERVAL_MS ?? 10);
	const snapshots = process.env.SNAPSHOTS === "1";

	const gpio = process.env.GPIO_MOCK ? new MockGpio() : new Gpio();
	await gpio.init();
	const pin = gpio.pin(bcm);
	await pin.setOutput({ initialValue: false });

	console.log(
		`soaking BCM ${bcm}: fire-and-forget write every ${intervalMs}ms for ${durationMs / 1000}s`,
	);

	let value = false;
	let writes = 0;
	let errors = 0;
	const toggle = setInterval(() => {
		value = !value;
		writes++;
		// Deliberately not awaited — mirrors the incident. Errors must reject
		// (and be observable here), never silently pin the heap.
		pin.write(value).catch(() => {
			errors++;
		});
	}, intervalMs);

	const start = Date.now();
	const baseline = process.memoryUsage().heapUsed;
	const report = setInterval(() => {
		if (globalThis.gc) globalThis.gc();
		const heap = process.memoryUsage().heapUsed;
		const drift = (heap - baseline) / 1024 / 1024;
		console.log(
			`t=${Math.round((Date.now() - start) / 1000)}s writes=${writes} errors=${errors} ` +
				`heapUsed=${(heap / 1024 / 1024).toFixed(1)}MB (drift ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}MB)`,
		);
	}, 5000);

	if (snapshots) {
		setTimeout(() => console.log("snapshot:", writeHeapSnapshot()), 10_000);
		setTimeout(() => console.log("snapshot:", writeHeapSnapshot()), 70_000);
	}

	await new Promise((resolve) => setTimeout(resolve, durationMs));

	clearInterval(toggle);
	clearInterval(report);
	await gpio.release();
	const finalHeap = process.memoryUsage().heapUsed;
	console.log(
		`done: ${writes} writes, ${errors} errors, final heapUsed ${(finalHeap / 1024 / 1024).toFixed(1)}MB`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
