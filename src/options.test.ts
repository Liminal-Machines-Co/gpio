import { expect, test } from "bun:test";
import {
	validateBcm,
	validateGpioOptions,
	validatePinInputOptions,
	validatePinOutputOptions,
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
