import type {
	Edge,
	GpioOptions,
	PinInputOptions,
	PinOutputOptions,
} from "./types.js";

const VALID_EDGES: readonly Edge[] = ["rising", "falling", "both"];

// The 40-pin header only exposes BCM 0-27, but RP1 (Pi 5) and other chips can
// expose lines beyond that range, so we allow the full BCM/RP1 address space
// rather than hard-coding 0-27.
const MIN_BCM = 0;
const MAX_BCM = 53;

export function validateBcm(bcm: number): void {
	if (
		typeof bcm !== "number" ||
		!Number.isInteger(bcm) ||
		bcm < MIN_BCM ||
		bcm > MAX_BCM
	)
		throw new TypeError(
			`Pin bcm must be an integer between ${MIN_BCM} and ${MAX_BCM}`,
		);
}

export function validateGpioOptions(options?: GpioOptions): void {
	if (!options) return;
	if (
		options.chip !== undefined &&
		(typeof options.chip !== "string" || options.chip.length === 0)
	)
		throw new TypeError("GpioOptions chip must be a non-empty string");
}

export function validatePinInputOptions(options?: PinInputOptions): void {
	if (!options) return;
	if (options.pullup && options.pulldown)
		throw new TypeError("Pin cannot enable both pullup and pulldown");
	if (options.edge !== undefined && !VALID_EDGES.includes(options.edge))
		throw new TypeError(`Pin edge must be one of: ${VALID_EDGES.join(", ")}`);
	if (options.debounce !== undefined) {
		if (typeof options.debounce !== "number" || options.debounce < 0)
			throw new TypeError("Pin debounce must be a non-negative number");
	}
}

export function validatePinOutputOptions(options?: PinOutputOptions): void {
	if (!options) return;
	if (options.openDrain && options.openSource)
		throw new TypeError("Pin cannot enable both openDrain and openSource");
}

// Convenience wrapper matching the `validatePinOptions(bcm, opts)` shape from
// the plan; validates both the bcm number and whichever option set applies.
export function validatePinOptions(
	bcm: number,
	options?: PinInputOptions | PinOutputOptions,
): void {
	validateBcm(bcm);
	if (!options) return;
	if ("edge" in options || "pullup" in options || "pulldown" in options) {
		validatePinInputOptions(options as PinInputOptions);
	}
	if ("openDrain" in options || "openSource" in options) {
		validatePinOutputOptions(options as PinOutputOptions);
	}
}
