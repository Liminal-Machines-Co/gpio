import { expect, test } from "bun:test";
import {
	pwmChannelForBcm,
	validateBcm,
	validateDutyCycle,
	validateFrequency,
	validateGpioOptions,
	validatePinInputOptions,
	validatePinOutputOptions,
	validatePwmChannelConfig,
} from "./options.js";

test("validateBcm accepts values in range", () => {
	expect(() => validateBcm(0)).not.toThrow();
	expect(() => validateBcm(17)).not.toThrow();
	expect(() => validateBcm(53)).not.toThrow();
});

test("validateBcm rejects out-of-range and non-integer values", () => {
	expect(() => validateBcm(-1)).toThrow(TypeError);
	expect(() => validateBcm(54)).toThrow(TypeError);
	expect(() => validateBcm(1.5)).toThrow(TypeError);
	expect(() => validateBcm(Number.NaN)).toThrow(TypeError);
});

test("validateGpioOptions accepts a valid chip", () => {
	expect(() => validateGpioOptions({ chip: "gpiochip0" })).not.toThrow();
	expect(() => validateGpioOptions(undefined)).not.toThrow();
	expect(() => validateGpioOptions({})).not.toThrow();
});

test("validateGpioOptions rejects an empty chip string", () => {
	expect(() => validateGpioOptions({ chip: "" })).toThrow(TypeError);
});

test("validatePinInputOptions accepts valid edges", () => {
	expect(() => validatePinInputOptions({ edge: "rising" })).not.toThrow();
	expect(() => validatePinInputOptions({ edge: "falling" })).not.toThrow();
	expect(() => validatePinInputOptions({ edge: "both" })).not.toThrow();
});

test("validatePinInputOptions rejects an invalid edge", () => {
	// biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
	expect(() => validatePinInputOptions({ edge: "sideways" as any })).toThrow(
		TypeError,
	);
});

test("validatePinInputOptions rejects a negative debounce", () => {
	expect(() => validatePinInputOptions({ debounce: -1 })).toThrow(TypeError);
});

test("validatePinInputOptions accepts a zero debounce", () => {
	expect(() => validatePinInputOptions({ debounce: 0 })).not.toThrow();
});

test("validatePinInputOptions rejects pullup and pulldown together", () => {
	expect(() =>
		validatePinInputOptions({ pullup: true, pulldown: true }),
	).toThrow(TypeError);
});

test("validatePinOutputOptions rejects openDrain and openSource together", () => {
	expect(() =>
		validatePinOutputOptions({ openDrain: true, openSource: true }),
	).toThrow(TypeError);
});

test("validatePinOutputOptions accepts a valid config", () => {
	expect(() =>
		validatePinOutputOptions({ initialValue: true, openDrain: true }),
	).not.toThrow();
});

test("pwmChannelForBcm maps the hardware-PWM pins", () => {
	expect(pwmChannelForBcm(12)).toBe(0);
	expect(pwmChannelForBcm(18)).toBe(0);
	expect(pwmChannelForBcm(13)).toBe(1);
	expect(pwmChannelForBcm(19)).toBe(1);
});

test("pwmChannelForBcm rejects non-PWM pins", () => {
	expect(() => pwmChannelForBcm(5)).toThrow(/not a hardware-PWM pin/);
	expect(() => pwmChannelForBcm(17)).toThrow(TypeError);
});

test("validatePwmChannelConfig accepts valid configs", () => {
	expect(() => validatePwmChannelConfig(undefined)).not.toThrow();
	expect(() =>
		validatePwmChannelConfig({ frequency: 1000, dutyCycle: 0.5 }),
	).not.toThrow();
	expect(() =>
		validatePwmChannelConfig({ period: 1_000_000, polarity: "inversed" }),
	).not.toThrow();
});

test("validatePwmChannelConfig rejects frequency and period together", () => {
	expect(() =>
		validatePwmChannelConfig({ frequency: 1000, period: 1_000_000 }),
	).toThrow(TypeError);
});

test("validatePwmChannelConfig rejects out-of-range duty cycle", () => {
	expect(() => validatePwmChannelConfig({ dutyCycle: -0.1 })).toThrow(
		TypeError,
	);
	expect(() => validatePwmChannelConfig({ dutyCycle: 1.5 })).toThrow(TypeError);
});

test("validatePwmChannelConfig rejects a non-positive frequency", () => {
	expect(() => validatePwmChannelConfig({ frequency: 0 })).toThrow(TypeError);
});

test("validatePwmChannelConfig rejects an invalid polarity", () => {
	expect(() =>
		// biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
		validatePwmChannelConfig({ polarity: "sideways" as any }),
	).toThrow(TypeError);
});

test("validateDutyCycle / validateFrequency guard ranges", () => {
	expect(() => validateDutyCycle(0.5)).not.toThrow();
	expect(() => validateDutyCycle(2)).toThrow(TypeError);
	expect(() => validateFrequency(1000)).not.toThrow();
	expect(() => validateFrequency(0)).toThrow(TypeError);
});
