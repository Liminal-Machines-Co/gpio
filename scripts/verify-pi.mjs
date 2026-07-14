#!/usr/bin/env node

// -----------------------------------------------------------------------------
// verify-pi.mjs — end-to-end hardware verification for @liminal-machines-co/gpio
//
// Run this ON A RASPBERRY PI (3, 4, or 5). It exercises every v1 use case
// against real silicon and prints a full, structured log plus a machine-parseable
// JSON block at the end. Send the entire output back for verification.
//
// PREREQUISITES ON THE PI
//   1. Build the library first (from the repo root):
//        npm install
//        npm run build          # native addon + dist/  (needs Zig 0.16 + Node >=18)
//      If you are on 64-bit Raspberry Pi OS you can instead rely on the bundled
//      prebuilds/linux-arm64/gpio.node and just run:  npm run build:ts
//   2. Run with permission to access the GPIO char device (in the `gpio` group,
//      or with sudo):
//        node scripts/verify-pi.mjs
//
// WIRING (for the loopback checks)
//   Connect a single jumper wire between the OUT pin and the IN pin.
//   The FLOAT pin must be left UNCONNECTED (its internal pull resistors are tested).
//
//   Defaults (BCM numbering):
//     OUT_PIN   = 23   (physical header pin 16)
//     IN_PIN    = 24   (physical header pin 18)   <-- jumper OUT_PIN <-> IN_PIN
//     FLOAT_PIN = 25   (physical header pin 22)   <-- leave floating
//
//   Override via env vars, e.g.:
//     OUT_PIN=17 IN_PIN=27 FLOAT_PIN=22 CHIP=/dev/gpiochip0 node scripts/verify-pi.mjs
//
//   Checks that need the jumper are tagged [needs-jumper]; the rest run standalone.
// -----------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const OUT_PIN = Number(process.env.OUT_PIN ?? 23);
const IN_PIN = Number(process.env.IN_PIN ?? 24);
const FLOAT_PIN = Number(process.env.FLOAT_PIN ?? 25);
const CHIP = process.env.CHIP; // optional override, e.g. /dev/gpiochip0

const results = [];
let checkNo = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
	console.log(...args);
}

function record({ name, tag, expected, actual, pass, note, error }) {
	checkNo += 1;
	const entry = {
		n: checkNo,
		name,
		tag: tag ?? null,
		expected: expected ?? null,
		actual: actual ?? null,
		pass,
		note: note ?? null,
		error: error ? String(error && error.stack ? error.stack : error) : null,
	};
	results.push(entry);
	const status = pass ? "PASS" : "FAIL";
	const tagStr = tag ? ` ${tag}` : "";
	log(`\n[CHECK ${checkNo}]${tagStr} ${name} -> ${status}`);
	if (expected !== undefined) log(`   expected: ${JSON.stringify(expected)}`);
	if (actual !== undefined) log(`   actual:   ${JSON.stringify(actual)}`);
	if (note) log(`   note:     ${note}`);
	if (entry.error) log(`   error:    ${entry.error}`);
}

// Run an assertion-style check; captures throws as failures.
async function check(name, tag, fn) {
	try {
		const r = await fn();
		record({
			name,
			tag,
			expected: r?.expected,
			actual: r?.actual,
			pass: r?.pass ?? false,
			note: r?.note,
		});
	} catch (error) {
		record({ name, tag, pass: false, error });
	}
}

// A check whose success IS that the body throws (error-path testing).
async function checkThrows(name, tag, expectedMsgSubstr, fn) {
	try {
		await fn();
		record({
			name,
			tag,
			expected: `throw containing "${expectedMsgSubstr}"`,
			actual: "did not throw",
			pass: false,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		record({
			name,
			tag,
			expected: `throw containing "${expectedMsgSubstr}"`,
			actual: msg,
			pass: msg.includes(expectedMsgSubstr),
		});
	}
}

// -----------------------------------------------------------------------------

function readSysInfo() {
	const info = {};
	try {
		info.model = readFileSync("/proc/device-tree/model", "utf8")
			.replace(/\0/g, "")
			.trim();
	} catch {
		info.model = "unknown (could not read /proc/device-tree/model)";
	}
	try {
		const cpu = readFileSync("/proc/cpuinfo", "utf8");
		const rev = cpu.match(/Revision\s*:\s*(\S+)/);
		const hw = cpu.match(/Hardware\s*:\s*(\S+)/);
		info.revision = rev ? rev[1] : null;
		info.hardware = hw ? hw[1] : null;
	} catch {
		/* ignore */
	}
	info.kernel = process.report?.getReport?.().header?.osRelease ?? null;
	info.node = process.version;
	info.platform = `${process.platform}-${process.arch}`;
	return info;
}

async function main() {
	log("=".repeat(78));
	log("  @liminal-machines-co/gpio — Raspberry Pi verification");
	log("=".repeat(78));

	// --- Environment -----------------------------------------------------------
	const sys = readSysInfo();
	let pkgVersion = "unknown";
	try {
		pkgVersion = require(resolve(repoRoot, "package.json")).version;
	} catch {
		/* ignore */
	}
	log("\n--- ENVIRONMENT ---");
	log(`  package version : ${pkgVersion}`);
	log(`  board model     : ${sys.model}`);
	log(`  board revision  : ${sys.revision ?? "n/a"}`);
	log(`  node            : ${sys.node}`);
	log(`  platform        : ${sys.platform}`);
	log(`  OUT_PIN (BCM)   : ${OUT_PIN}   (drive; jumper to IN_PIN)`);
	log(`  IN_PIN  (BCM)   : ${IN_PIN}   (sense; jumper to OUT_PIN)`);
	log(`  FLOAT_PIN (BCM) : ${FLOAT_PIN}   (leave UNCONNECTED)`);
	log(`  CHIP override   : ${CHIP ?? "(auto-detect)"}`);

	// --- Load the library ------------------------------------------------------
	const distPath = resolve(repoRoot, "dist", "index.js");
	if (!existsSync(distPath)) {
		log(
			`\nFATAL: ${distPath} not found. Run \`npm run build\` (or build:ts) first.`,
		);
		dump(sys, pkgVersion, "dist-not-built");
		process.exit(2);
	}
	let lib;
	let native;
	try {
		lib = require(distPath);
	} catch (error) {
		log(`\nFATAL: failed to load dist/index.js: ${error?.stack ?? error}`);
		dump(sys, pkgVersion, "lib-load-failed");
		process.exit(2);
	}
	try {
		native = require(resolve(repoRoot, "index.js"));
	} catch (error) {
		log(
			`\nWARN: could not load native index.js directly: ${error?.message ?? error}`,
		);
	}
	const { Gpio, MockGpio } = lib;

	// --- Native introspection --------------------------------------------------
	log("\n--- NATIVE INTROSPECTION ---");
	await check("Gpio.listChips() returns chip list", null, async () => {
		const chips = await Gpio.listChips();
		log(`   chips: ${JSON.stringify(chips, null, 2)}`);
		return {
			expected: "non-empty array of { path, name, label, lines }",
			actual: chips,
			pass: Array.isArray(chips) && chips.length > 0,
		};
	});
	if (native && typeof native.detectHeaderChip === "function") {
		await check(
			"native.detectHeaderChip() finds header chip",
			null,
			async () => {
				const detected = native.detectHeaderChip();
				return {
					expected:
						"a /dev/gpiochip* path (pinctrl-bcm2835/2711 or pinctrl-rp1)",
					actual: detected,
					pass: typeof detected === "string" && detected.length > 0,
				};
			},
		);
	}

	// --- MockGpio parity (hardware-free path) ----------------------------------
	log("\n--- MOCK PARITY (no hardware) ---");
	await check("MockGpio: driveInput fires onChange", null, async () => {
		const g = new MockGpio();
		const events = [];
		const p = g.pin(5);
		await p.setInput({
			edge: "both",
			onChange: (v, ts) => events.push({ v, ts }),
		});
		p.driveInput(true);
		p.driveInput(false);
		await g.release();
		const okTypes = events.length === 2 && typeof events[0].ts === "bigint";
		return {
			expected: "2 events: [true, false] with bigint timestamps",
			actual: events.map((e) => ({ v: e.v, tsType: typeof e.ts })),
			pass: okTypes && events[0].v === true && events[1].v === false,
		};
	});
	await check("MockGpio: write then getOutput", null, async () => {
		const g = new MockGpio();
		const p = g.pin(6);
		await p.setOutput();
		await p.write(true);
		const got = p.getOutput();
		await g.release();
		return { expected: true, actual: got, pass: got === true };
	});

	// --- Real hardware ---------------------------------------------------------
	log("\n--- HARDWARE ---");
	const gpio = CHIP ? new Gpio({ chip: CHIP }) : new Gpio();
	let outPin;
	let inPin;
	let floatPin;

	try {
		// Auto-detect / open sanity: configuring any pin forces the chip open.
		await check("Gpio opens chip + configures output pin", null, async () => {
			outPin = gpio.pin(OUT_PIN);
			await outPin.setOutput({ initialValue: false });
			return {
				expected: `direction "out" on BCM ${OUT_PIN}`,
				actual: outPin.direction,
				pass: outPin.direction === "out",
			};
		});

		await check("configure input pin", null, async () => {
			inPin = gpio.pin(IN_PIN);
			await inPin.setInput();
			return {
				expected: `direction "in" on BCM ${IN_PIN}`,
				actual: inPin.direction,
				pass: inPin.direction === "in",
			};
		});

		// Loopback: drive high, sense high.
		await check("write HIGH -> read HIGH", "[needs-jumper]", async () => {
			await outPin.write(true);
			await sleep(25);
			const v = await inPin.read();
			return { expected: true, actual: v, pass: v === true };
		});

		await check("write LOW -> read LOW", "[needs-jumper]", async () => {
			await outPin.write(false);
			await sleep(25);
			const v = await inPin.read();
			return { expected: false, actual: v, pass: v === false };
		});

		// Edge callbacks: reconfigure input with edges (also tests reconfigure).
		await check(
			"edge onChange fires on both edges",
			"[needs-jumper]",
			async () => {
				const events = [];
				await inPin.setInput({
					edge: "both",
					debounce: 1000,
					onChange: (v, ts) => events.push({ v, ts }),
				});
				await outPin.write(false);
				await sleep(30);
				await outPin.write(true); // rising
				await sleep(60);
				await outPin.write(false); // falling
				await sleep(60);
				const tsAllBigint = events.every((e) => typeof e.ts === "bigint");
				const sawRising = events.some((e) => e.v === true);
				const sawFalling =
					events.some((e) => e.v === true) && events.some((e) => e.v === false);
				log(
					`   events: ${JSON.stringify(events.map((e) => ({ v: e.v, ts: e.ts?.toString() })))}`,
				);
				return {
					expected:
						"at least one rising(true) and one falling(false) event, bigint timestamps",
					actual: {
						count: events.length,
						values: events.map((e) => e.v),
						timestampsBigint: tsAllBigint,
					},
					pass: sawRising && sawFalling && tsAllBigint,
				};
			},
		);

		// Timestamps monotonic across events (frequency/timing correctness).
		await check(
			"edge timestamps are monotonic non-decreasing",
			"[needs-jumper]",
			async () => {
				const events = [];
				await inPin.setInput({
					edge: "both",
					onChange: (v, ts) => events.push(ts),
				});
				for (let i = 0; i < 4; i++) {
					await outPin.write(i % 2 === 0);
					await sleep(40);
				}
				let monotonic = true;
				for (let i = 1; i < events.length; i++) {
					if (events[i] < events[i - 1]) monotonic = false;
				}
				return {
					expected: "non-decreasing bigint timestamps",
					actual: events.map((t) => t?.toString()),
					pass: events.length >= 2 && monotonic,
				};
			},
		);

		// --- Internal bias (no wire needed) on the FLOAT pin -------------------
		await check(
			"input pull-up reads HIGH (floating pin)",
			"[float-pin]",
			async () => {
				floatPin = gpio.pin(FLOAT_PIN);
				await floatPin.setInput({ pullup: true });
				await sleep(10);
				const v = await floatPin.read();
				return { expected: true, actual: v, pass: v === true };
			},
		);

		await check(
			"input pull-down reads LOW (floating pin)",
			"[float-pin]",
			async () => {
				await floatPin.setInput({ pulldown: true }); // reconfigure bias in place
				await sleep(10);
				const v = await floatPin.read();
				return { expected: false, actual: v, pass: v === false };
			},
		);

		await check(
			"activeLow inverts pull-up (floating pin)",
			"[float-pin]",
			async () => {
				await floatPin.setInput({ pullup: true, activeLow: true });
				await sleep(10);
				const v = await floatPin.read();
				return {
					expected: false,
					actual: v,
					note: "physical HIGH via pull-up, inverted by activeLow -> logical false",
					pass: v === false,
				};
			},
		);

		// --- Reconfigure direction in place ------------------------------------
		await check(
			"reconfigure FLOAT pin input -> output",
			"[float-pin]",
			async () => {
				await floatPin.setOutput({ initialValue: true });
				await floatPin.write(false);
				await floatPin.write(true);
				return {
					expected: `direction "out"`,
					actual: floatPin.direction,
					pass: floatPin.direction === "out",
				};
			},
		);

		// --- Error paths -------------------------------------------------------
		await checkThrows(
			"read() on an output pin throws",
			null,
			"not configured as an input",
			async () => {
				await outPin.read();
			},
		);
		await checkThrows(
			"write() on an input pin throws",
			null,
			"not configured as an output",
			async () => {
				await inPin.write(true);
			},
		);

		// --- Release semantics -------------------------------------------------
		await check("pin.release() then re-request works", null, async () => {
			await floatPin.release();
			const reReleasedDir = floatPin.direction;
			// re-acquire the same BCM line
			const again = gpio.pin(FLOAT_PIN);
			await again.setOutput();
			return {
				expected: `direction null after release, then "out" after re-request`,
				actual: {
					afterRelease: reReleasedDir,
					afterReacquire: again.direction,
				},
				pass: reReleasedDir === null && again.direction === "out",
			};
		});

		await check(
			"pin.release() is idempotent (double release)",
			null,
			async () => {
				await inPin.release();
				await inPin.release(); // must not throw
				return {
					expected: "no throw, direction null",
					actual: inPin.direction,
					pass: inPin.direction === null,
				};
			},
		);
	} finally {
		await check(
			"gpio.release() releases everything (idempotent)",
			null,
			async () => {
				await gpio.release();
				await gpio.release(); // must not throw
				return {
					expected: "no throw on double release",
					actual: "released",
					pass: true,
				};
			},
		);
	}

	dump(sys, pkgVersion, "complete");
}

function dump(sys, pkgVersion, phase) {
	const passed = results.filter((r) => r.pass).length;
	const failed = results.length - passed;
	log(`\n${"=".repeat(78)}`);
	log(
		`  SUMMARY: ${passed}/${results.length} checks passed, ${failed} failed  (phase: ${phase})`,
	);
	log("=".repeat(78));
	// Machine-parseable block — paste this whole block back for verification.
	const payload = {
		phase,
		pkgVersion,
		env: sys,
		pins: { OUT_PIN, IN_PIN, FLOAT_PIN, chip: CHIP ?? "auto" },
		summary: { total: results.length, passed, failed },
		checks: results.map((r) => ({
			...r,
			actual: r.actual,
			expected: r.expected,
		})),
	};
	log("\n=== JSON RESULTS (copy everything between the markers) ===");
	log("<<<GPIO_VERIFY_JSON");
	log(
		JSON.stringify(
			payload,
			(_k, v) => (typeof v === "bigint" ? v.toString() : v),
			2,
		),
	);
	log("GPIO_VERIFY_JSON>>>");
}

main().catch((error) => {
	log(`\nFATAL (uncaught): ${error?.stack ?? error}`);
	const sys = readSysInfo();
	dump(sys, "unknown", "fatal");
	process.exit(1);
});
