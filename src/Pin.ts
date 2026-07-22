import {
	validatePinInputOptions,
	validatePinOutputOptions,
} from "./options.js";
import type { PwmChannel } from "./PwmChannel.js";
import type {
	IPin,
	IPwmChannel,
	NativeLineConfig,
	PinDirection,
	PinInputOptions,
	PinOutputOptions,
	PwmChannelConfig,
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
	_pwmClaim(bcm: number): Promise<PwmChannel>;
}

// A pin holds a single exclusive mode. This is what makes GPIO↔PWM collisions
// impossible on one pin: it can be digital in/out OR PWM, never both at once.
type PinMode = "in" | "out" | "pwm" | null;

export class Pin implements IPin {
	public readonly bcm: number;

	/** @internal invoked by the parent Gpio's event router on each edge. */
	onChange: ((value: boolean, timestamp: bigint) => void) | undefined;

	private readonly _gpio: GpioInternal;
	private _mode: PinMode;
	private _requested: boolean;
	private _pwmChannel: PwmChannel | undefined;

	constructor(gpio: GpioInternal, bcm: number) {
		this._gpio = gpio;
		this.bcm = bcm;
		this._mode = null;
		this._requested = false;
		this._pwmChannel = undefined;
	}

	/** Current digital direction, or null when unconfigured or in PWM mode. */
	get direction(): PinDirection | null {
		return this._mode === "in" || this._mode === "out" ? this._mode : null;
	}

	async setInput(options?: PinInputOptions): Promise<void> {
		validatePinInputOptions(options);
		await this._teardownPwm();
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
		this._mode = "in";
	}

	async setOutput(options?: PinOutputOptions): Promise<void> {
		validatePinOutputOptions(options);
		await this._teardownPwm();
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
		this._mode = "out";
	}

	async pwm(config?: PwmChannelConfig): Promise<IPwmChannel> {
		// Claim first (validates the pin is PWM-capable and resolves the chip)
		// before tearing down any existing digital line, so a bad call leaves the
		// pin as it was.
		const channel = await this._gpio._pwmClaim(this.bcm);
		if (this._requested) {
			this._gpio._releaseLine(this.bcm);
			this._requested = false;
		}
		this.onChange = undefined;
		this._mode = "pwm";
		this._pwmChannel = channel;
		await channel._configure(config);
		return channel;
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
		await this._teardownPwm();
		if (this._requested) {
			this._gpio._releaseLine(this.bcm);
			this._requested = false;
		}
		this._mode = null;
		this.onChange = undefined;
	}

	/** @internal invoked by the parent Gpio's event router. */
	_emit(value: boolean, timestamp: bigint): void {
		this.onChange?.(value, timestamp);
	}

	/** @internal invoked by Gpio when this pin's PWM channel is released. */
	_onPwmReleased(): void {
		this._pwmChannel = undefined;
		if (this._mode === "pwm") this._mode = null;
	}

	private async _teardownPwm(): Promise<void> {
		if (this._pwmChannel) {
			// release() calls back into _onPwmReleased, clearing our state.
			await this._pwmChannel.release();
		}
	}
}
