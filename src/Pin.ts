import {
	validatePinInputOptions,
	validatePinOutputOptions,
} from "./options.js";
import type {
	IPin,
	NativeLineConfig,
	PinDirection,
	PinInputOptions,
	PinOutputOptions,
} from "./types.js";

// Minimal surface Pin needs from its parent Gpio. Kept as an interface (with
// internal, package-private methods) so Gpio.ts owns the actual native
// binding + open lifecycle and Pin.ts stays a thin per-line wrapper.
export interface GpioInternal {
	_ensureOpen(): Promise<void>;
	_requestLine(offset: number, config: NativeLineConfig): void;
	_setConfig(offset: number, config: NativeLineConfig): void;
	_readLine(offset: number): Promise<boolean>;
	_writeLine(offset: number, value: boolean): Promise<void>;
	_releaseLine(offset: number): void;
}

export class Pin implements IPin {
	public readonly bcm: number;
	public direction: PinDirection | null;

	/** @internal invoked by the parent Gpio's event router on each edge. */
	onChange: ((value: boolean, timestamp: bigint) => void) | undefined;

	private readonly _gpio: GpioInternal;
	private _requested: boolean;

	constructor(gpio: GpioInternal, bcm: number) {
		this._gpio = gpio;
		this.bcm = bcm;
		this.direction = null;
		this._requested = false;
	}

	async setInput(options?: PinInputOptions): Promise<void> {
		validatePinInputOptions(options);
		await this._gpio._ensureOpen();

		const config: NativeLineConfig = { direction: "in" };
		if (options?.pullup !== undefined) config.pullup = options.pullup;
		if (options?.pulldown !== undefined) config.pulldown = options.pulldown;
		if (options?.activeLow !== undefined) config.activeLow = options.activeLow;
		if (options?.edge !== undefined) config.edge = options.edge;
		if (options?.debounce !== undefined) config.debounce = options.debounce;

		if (this._requested) {
			this._gpio._setConfig(this.bcm, config);
		} else {
			this._gpio._requestLine(this.bcm, config);
			this._requested = true;
		}

		this.onChange = options?.onChange;
		this.direction = "in";
	}

	async setOutput(options?: PinOutputOptions): Promise<void> {
		validatePinOutputOptions(options);
		await this._gpio._ensureOpen();

		const config: NativeLineConfig = { direction: "out" };
		if (options?.initialValue !== undefined)
			config.initialValue = options.initialValue;
		if (options?.openDrain !== undefined) config.openDrain = options.openDrain;
		if (options?.openSource !== undefined)
			config.openSource = options.openSource;
		if (options?.activeLow !== undefined) config.activeLow = options.activeLow;

		if (this._requested) {
			this._gpio._setConfig(this.bcm, config);
		} else {
			this._gpio._requestLine(this.bcm, config);
			this._requested = true;
		}

		this.onChange = undefined;
		this.direction = "out";
	}

	async read(): Promise<boolean> {
		if (this.direction !== "in")
			throw new Error(`Pin ${this.bcm} is not configured as an input`);
		return this._gpio._readLine(this.bcm);
	}

	async write(value: boolean): Promise<void> {
		if (this.direction !== "out")
			throw new Error(`Pin ${this.bcm} is not configured as an output`);
		return this._gpio._writeLine(this.bcm, value);
	}

	async release(): Promise<void> {
		if (!this._requested) {
			this.direction = null;
			this.onChange = undefined;
			return;
		}
		this._gpio._releaseLine(this.bcm);
		this._requested = false;
		this.direction = null;
		this.onChange = undefined;
	}

	/** @internal invoked by the parent Gpio's event router. */
	_emit(value: boolean, timestamp: bigint): void {
		this.onChange?.(value, timestamp);
	}
}
