import { describe, expect, test } from "bun:test";
import { MockGpio, type MockPwmChannel } from "./MockGpio.js";

describe("MockGpio PWM", () => {
	test("pin.pwm() returns a channel reflecting the config", async () => {
		const gpio = new MockGpio();
		const led = (await gpio
			.pin(12)
			.pwm({ frequency: 2000, dutyCycle: 0.25 })) as MockPwmChannel;
		expect(led.bcm).toBe(12);
		expect(led.channel).toBe(0);
		expect(led.getFrequency()).toBe(2000);
		expect(led.getDutyCycle()).toBe(0.25);
		expect(led.isEnabled()).toBe(true);
	});

	test("period config maps to a frequency", async () => {
		const gpio = new MockGpio();
		const ch = (await gpio
			.pin(13)
			.pwm({ period: 1_000_000 })) as MockPwmChannel;
		expect(ch.getFrequency()).toBe(1000);
		expect(ch.channel).toBe(1);
	});

	test("write / setFrequency / setPolarity update state", async () => {
		const gpio = new MockGpio();
		const led = (await gpio.pin(18).pwm()) as MockPwmChannel;
		await led.write(0.5);
		expect(led.getDutyCycle()).toBe(0.5);
		await led.setFrequency(500);
		expect(led.getFrequency()).toBe(500);
		await led.setPolarity("inversed");
		expect(led.getPolarity()).toBe("inversed");
		await led.disable();
		expect(led.isEnabled()).toBe(false);
	});

	test("pin enters PWM mode (direction becomes null)", async () => {
		const gpio = new MockGpio();
		const pin = gpio.pin(12);
		await pin.setOutput();
		expect(pin.direction).toBe("out");
		await pin.pwm();
		expect(pin.direction).toBeNull();
	});

	test("switching back to output tears down the channel", async () => {
		const gpio = new MockGpio();
		const pin = gpio.pin(12);
		const led = (await pin.pwm()) as MockPwmChannel;
		await pin.setOutput();
		expect(pin.direction).toBe("out");
		await expect(led.write(0.5)).rejects.toThrow(/released/);
	});

	test("channel-sibling pins collide (12 and 18 share channel 0)", async () => {
		const gpio = new MockGpio();
		await gpio.pin(12).pwm();
		await expect(gpio.pin(18).pwm()).rejects.toThrow(
			/already in use by BCM 12/,
		);
	});

	test("releasing a channel frees the sibling", async () => {
		const gpio = new MockGpio();
		const led = (await gpio.pin(12).pwm()) as MockPwmChannel;
		await led.release();
		// 18 shares channel 0 — now free
		const other = (await gpio.pin(18).pwm()) as MockPwmChannel;
		expect(other.bcm).toBe(18);
	});

	test("non-PWM pin rejects", async () => {
		const gpio = new MockGpio();
		await expect(gpio.pin(5).pwm()).rejects.toThrow(/not a hardware-PWM pin/);
	});

	test("gpio.release() releases channels", async () => {
		const gpio = new MockGpio();
		const led = (await gpio.pin(12).pwm()) as MockPwmChannel;
		await gpio.release();
		await expect(led.write(0.5)).rejects.toThrow(/released/);
	});
});
