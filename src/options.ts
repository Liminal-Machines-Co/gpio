import type {
	Edge,
	GpioOptions,
	PinInputOptions,
	PinOutputOptions,
	PwmChannelConfig,
	PwmPolarity,
} from "./types.js";

const VALID_EDGES: readonly Edge[] = ["rising", "falling", "both"];
const VALID_POLARITIES: readonly PwmPolarity[] = ["normal", "inversed"];

// BCM -> sysfs PWM channel for the standard `dtoverlay=pwm-2chan` mux on Pi
// 3/4. BCM 12 & 18 both drive channel 0; 13 & 19 both drive channel 1 — so the
// two pins of a channel are mutually exclusive at the hardware level.
const PWM_CHANNEL_BY_BCM: Readonly<Record<number, number>> = {
	12: 0,
	18: 0,
	13: 1,
	19: 1,
};

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

/**
 * Resolve a BCM pin to its hardware-PWM channel, or throw if it isn't a
 * PWM-capable pin. Also validates the BCM range.
 */
export function pwmChannelForBcm(bcm: number): number {
	validateBcm(bcm);
	const channel = PWM_CHANNEL_BY_BCM[bcm];
	if (channel === undefined)
		throw new TypeError(
			`BCM ${bcm} is not a hardware-PWM pin (expected one of 12, 13, 18, 19)`,
		);
	return channel;
}

export function validatePwmChannelConfig(config?: PwmChannelConfig): void {
	if (!config) return;
	if (config.frequency !== undefined && config.period !== undefined)
		throw new TypeError("PWM config cannot set both frequency and period");
	if (config.frequency !== undefined) {
		if (typeof config.frequency !== "number" || config.frequency <= 0)
			throw new TypeError("PWM frequency must be a positive number");
	}
	if (config.period !== undefined) {
		if (typeof config.period !== "number" || config.period <= 0)
			throw new TypeError("PWM period must be a positive number");
	}
	if (config.dutyCycle !== undefined) {
		if (
			typeof config.dutyCycle !== "number" ||
			config.dutyCycle < 0 ||
			config.dutyCycle > 1
		)
			throw new TypeError("PWM dutyCycle must be a ratio between 0 and 1");
	}
	if (
		config.polarity !== undefined &&
		!VALID_POLARITIES.includes(config.polarity)
	)
		throw new TypeError(
			`PWM polarity must be one of: ${VALID_POLARITIES.join(", ")}`,
		);
}

/** Validate a standalone duty-cycle ratio (used by `write`/`setDutyCycle`). */
export function validateDutyCycle(ratio: number): void {
	if (typeof ratio !== "number" || ratio < 0 || ratio > 1)
		throw new TypeError("PWM dutyCycle must be a ratio between 0 and 1");
}

/** Validate a standalone frequency in Hz (used by `setFrequency`). */
export function validateFrequency(hz: number): void {
	if (typeof hz !== "number" || hz <= 0)
		throw new TypeError("PWM frequency must be a positive number");
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
