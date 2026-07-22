import { describe, expect, test } from "bun:test";
import { Gpio } from "./Gpio.js";

// Hermetic: nothing here opens the chip, so the native binding is never
// loaded (construction and release are lazy about it).
describe("Gpio lifecycle", () => {
	test("exit listener is shared, not per instance", async () => {
		const first = new Gpio();
		const count = process.listenerCount("exit");

		const others = Array.from({ length: 50 }, () => new Gpio());
		expect(process.listenerCount("exit")).toBe(count);

		await first.release();
		for (const gpio of others) await gpio.release();
		expect(process.listenerCount("exit")).toBe(count);
	});

	test("release is idempotent", async () => {
		const gpio = new Gpio();
		await gpio.release();
		await gpio.release();
	});

	test("configuring a pin after release rejects", async () => {
		const gpio = new Gpio();
		const pin = gpio.pin(4);
		await gpio.release();
		expect(pin.setOutput()).rejects.toThrow("Gpio has been released");
	});

	test("init after release rejects", async () => {
		const gpio = new Gpio();
		await gpio.release();
		expect(gpio.init()).rejects.toThrow("Gpio has been released");
	});

	// Hermetic: pwm() on a non-PWM pin is rejected by the BCM→channel map
	// before any sysfs is touched, so this runs anywhere.
	test("pwm on a non-PWM pin rejects without touching sysfs", async () => {
		const gpio = new Gpio();
		await expect(gpio.pin(4).pwm()).rejects.toThrow(/not a hardware-PWM pin/);
		await gpio.release();
	});

	test("pwm after release rejects", async () => {
		const gpio = new Gpio();
		await gpio.release();
		await expect(gpio.pin(12).pwm()).rejects.toThrow("Gpio has been released");
	});
});
