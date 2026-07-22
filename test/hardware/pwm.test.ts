//! Hardware-in-the-loop PWM suite. Requires a real Raspberry Pi with hardware
//! PWM enabled (`dtoverlay=pwm-2chan` in /boot firmware config) and something
//! observable (LED + resistor, or a scope) on the PWM pin.
//!
//! Wiring (defaults, override via env):
//!   GPIO_TEST_PWM_BCM (default BCM 18) --- LED+resistor --- GND
//!
//! Run:
//!   GPIO_TEST_PWM_CHIP=pwmchip0 bun run test:hardware
//!   GPIO_TEST_PWM_CHIP=pwmchip0 GPIO_TEST_PWM_BCM=18 bun run test:hardware
//!
//! Skips entirely when GPIO_TEST_PWM_CHIP is unset.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers";
import { Gpio } from "../../src/Gpio.js";
import type { IPwmChannel } from "../../src/types.js";

const PWM_CHIP = process.env.GPIO_TEST_PWM_CHIP;
const PWM_BCM = Number(process.env.GPIO_TEST_PWM_BCM ?? 18);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readNs(channel: number, attr: string): Promise<number> {
	const base = PWM_CHIP?.startsWith("/")
		? PWM_CHIP
		: `/sys/class/pwm/${PWM_CHIP}`;
	const raw = await readFile(join(base, `pwm${channel}`, attr), "utf8");
	return Number.parseInt(raw.trim(), 10);
}

if (!PWM_CHIP) {
	console.log(`
--------

!IMPORTANT!
PWM chip for hardware test was not provided. Run PWM hardware tests like this:

--------

GPIO_TEST_PWM_CHIP=pwmchip0 bun run test:hardware

--------
    `);
}

describe.skipIf(!PWM_CHIP)("hardware: PWM output", () => {
	let gpio: Gpio;
	let led: IPwmChannel;

	beforeAll(async () => {
		gpio = new Gpio({ pwmChip: PWM_CHIP });
		led = await gpio.pin(PWM_BCM).pwm({ frequency: 1000, dutyCycle: 0.5 });
	});

	afterAll(async () => {
		await gpio?.release();
	});

	test("sets period and duty cycle in sysfs", async () => {
		await sleep(20);
		expect(await readNs(led.channel, "period")).toBe(1_000_000); // 1 kHz
		expect(await readNs(led.channel, "duty_cycle")).toBe(500_000); // 50%
		expect(await readNs(led.channel, "enable")).toBe(1);
	});

	test("write() updates the duty cycle", async () => {
		await led.write(0.25);
		await sleep(20);
		expect(await readNs(led.channel, "duty_cycle")).toBe(250_000);
	});

	test("setFrequency() preserves duty ratio", async () => {
		await led.setFrequency(2000); // period 500_000 ns
		await sleep(20);
		expect(await readNs(led.channel, "period")).toBe(500_000);
		expect(await readNs(led.channel, "duty_cycle")).toBe(125_000); // still 25%
	});
});
