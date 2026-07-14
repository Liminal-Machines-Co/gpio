//! Hardware-in-the-loop suite. Requires a real Raspberry Pi with a wired
//! loopback: jumper an output pin directly to an input pin so writes on one
//! are readable on the other.
//!
//! Wiring (defaults, override via env):
//!   GPIO_TEST_OUT (default BCM 23) --- jumper wire --- GPIO_TEST_IN (default BCM 24)
//!
//! Run:
//!   GPIO_TEST_CHIP=/dev/gpiochip0 bun run test:hardware
//!   GPIO_TEST_CHIP=gpiochip0 GPIO_TEST_OUT=23 GPIO_TEST_IN=24 bun run test:hardware
//!
//! Skips entirely when GPIO_TEST_CHIP is unset, so it is a separate opt-in
//! suite that never runs in CI or on a dev machine by accident.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setTimeout } from "node:timers";
import { Gpio } from "../../src/Gpio.js";
import type { Pin } from "../../src/Pin.js";

const CHIP = process.env.GPIO_TEST_CHIP;
const OUT_BCM = Number(process.env.GPIO_TEST_OUT ?? 23);
const IN_BCM = Number(process.env.GPIO_TEST_IN ?? 24);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!CHIP) {
	console.log(`
--------

!IMPORTANT!
Chip for hardware test was not provided. Use hardware tests like this:

--------

GPIO_TEST_CHIP=/dev/gpiochip0 bun run test:hardware

--------
    `);
}

describe.skipIf(!CHIP)("hardware: wired loopback", () => {
	let gpio: Gpio;
	let outPin: Pin;
	let inPin: Pin;

	beforeAll(async () => {
		gpio = new Gpio({ chip: CHIP as string });
		outPin = gpio.pin(OUT_BCM);
		inPin = gpio.pin(IN_BCM);
		await outPin.setOutput({ initialValue: false });
	});

	afterAll(async () => {
		await gpio?.release();
	});

	test("write high -> read high", async () => {
		await inPin.setInput();
		await outPin.write(true);
		await sleep(20);
		expect(await inPin.read()).toBe(true);
	});

	test("write low -> read low", async () => {
		await outPin.write(false);
		await sleep(20);
		expect(await inPin.read()).toBe(false);
	});

	test("onChange fires with a value and a bigint timestamp", async () => {
		const events: { value: boolean; timestamp: bigint }[] = [];
		await inPin.setInput({
			edge: "both",
			debounce: 1000,
			onChange: (value, timestamp) => {
				events.push({ value, timestamp });
			},
		});

		await outPin.write(true);
		await sleep(50);
		await outPin.write(false);
		await sleep(50);

		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(typeof events[0].value).toBe("boolean");
		expect(typeof events[0].timestamp).toBe("bigint");
	});
});
