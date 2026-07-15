// Public + native contract for the GPIO library.
//
// SYNC POINT: the native property names below (NativeLineConfig, INativeGpio)
// must stay identical across this file, src/Pin.ts, src/Gpio.ts, and
// src/napi/gpio_linux.zig. Any change to a config property must match the
// name read by the Zig `getNamed*` calls.

export type Edge = "rising" | "falling" | "both";
export type PinDirection = "in" | "out";

/** Options for configuring a pin as an input. */
export interface PinInputOptions {
	/** Enable the internal pull-up resistor. */
	pullup?: boolean;
	/** Enable the internal pull-down resistor. */
	pulldown?: boolean;
	/** Treat physical low as logical true (kernel-level inversion). */
	activeLow?: boolean;
	/** Deliver edge events of this direction to `onChange`. */
	edge?: Edge;
	/** Hardware debounce period in microseconds. */
	debounce?: number;
	/** Called on each edge event (requires `edge`). */
	onChange?: (value: boolean, timestamp: bigint) => void;
}

/** Options for configuring a pin as an output. */
export interface PinOutputOptions {
	/** Value to drive immediately on request. Defaults to false (low). */
	initialValue?: boolean;
	/** Open-drain output. */
	openDrain?: boolean;
	/** Open-source output. */
	openSource?: boolean;
	/** Treat logical true as physical low (kernel-level inversion). */
	activeLow?: boolean;
}

/** A single GPIO line, addressed by BCM number. */
export interface IPin {
	/** BCM number of this pin. */
	readonly bcm: number;
	/** Current configured direction, or null if unconfigured/released. */
	readonly direction: PinDirection | null;
	setInput(options?: PinInputOptions): Promise<void>;
	setOutput(options?: PinOutputOptions): Promise<void>;
	read(): Promise<boolean>;
	write(value: boolean): Promise<void>;
	release(): Promise<void>;
}

export interface GpioOptions {
	/**
	 * Override chip auto-detection. Accepts a chip name ("gpiochip0") or an
	 * absolute path ("/dev/gpiochip0"). When omitted, the 40-pin header chip is
	 * detected automatically.
	 */
	chip?: string;
}

/** The GPIO controller for a Raspberry Pi header. */
export interface IGpio {
	/**
	 * Optionally open the chip up front to fail fast on a missing device or
	 * insufficient permissions. Skipping it is fine — the chip is opened
	 * lazily on the first pin configuration. Idempotent.
	 */
	init(): Promise<void>;
	/** Return the stable cached Pin for a BCM number. */
	pin(bcm: number): IPin;
	/** Release all lines, stop the event thread, close the chip. Idempotent. */
	release(): Promise<void>;
}

/** A GPIO character device discovered under /dev. */
export interface ChipInfo {
	/** Absolute device path, e.g. "/dev/gpiochip0". */
	path: string;
	/** Device name, e.g. "gpiochip0". */
	name: string;
	/** Driver label, e.g. "pinctrl-bcm2711" / "pinctrl-rp1". */
	label: string;
	/** Number of lines on the chip. */
	lines: number;
}

// ---------------------------------------------------------------------------
// Native contract (implemented in src/napi/gpio_linux.zig)
// ---------------------------------------------------------------------------

/** Line configuration handed to the native requestLine / setConfig calls. */
export interface NativeLineConfig {
	direction: PinDirection;
	pullup?: boolean;
	pulldown?: boolean;
	openDrain?: boolean;
	openSource?: boolean;
	activeLow?: boolean;
	edge?: Edge;
	/** Debounce period in microseconds. */
	debounce?: number;
	initialValue?: boolean;
}

export interface INativeGpio {
	/**
	 * Open the chip device and register the single event callback. The event
	 * thread is spawned lazily when the first edge-enabled line is requested.
	 */
	open(
		chipPath: string,
		onEvent: (offset: number, value: boolean, timestamp: bigint) => void,
	): void;
	/** Request a line via GPIO_V2_GET_LINE_IOCTL. */
	requestLine(offset: number, config: NativeLineConfig): void;
	/** Reconfigure an already-requested line via GPIO_V2_LINE_SET_CONFIG_IOCTL. */
	setConfig(offset: number, config: NativeLineConfig): void;
	/** Read the current value via GPIO_V2_LINE_GET_VALUES_IOCTL. */
	readLine(offset: number): Promise<boolean>;
	/** Set the value via GPIO_V2_LINE_SET_VALUES_IOCTL. */
	writeLine(offset: number, value: boolean): Promise<void>;
	/** Release a single line (close its request fd, drop from poll set). */
	releaseLine(offset: number): void;
	/** Idempotent teardown: stop thread, release TSFN, close all fds. */
	close(): void;
}

export interface INativeGpioClass {
	new (): INativeGpio;
}
