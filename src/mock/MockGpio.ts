import {
	pwmChannelForBcm,
	validateBcm,
	validateDutyCycle,
	validateFrequency,
	validatePinInputOptions,
	validatePinOutputOptions,
	validatePwmChannelConfig,
} from "../options.js";
import type {
	Edge,
	IGpio,
	IPin,
	IPwmChannel,
	PinDirection,
	PinInputOptions,
	PinOutputOptions,
	PwmChannelConfig,
	PwmPolarity,
} from "../types.js";

function edgeMatches(edge: Edge, previous: boolean, next: boolean): boolean {
	if (previous === next) return false;
	if (edge === "both") return true;
	if (edge === "rising") return !previous && next;
	return previous && !next; // "falling"
}

const DEFAULT_FREQUENCY = 1000;

/**
 * Standalone virtual PWM channel for hermetic tests. Mirrors the real
 * `PwmChannel` surface but records state instead of writing sysfs, and exposes
 * test-only inspectors.
 */
export class MockPwmChannel implements IPwmChannel {
	public readonly bcm: number;
	public readonly channel: number;

	private readonly _onReleased: () => void;
	private _frequency: number;
	private _ratio: number;
	private _polarity: PwmPolarity;
	private _enabled: boolean;
	private _released: boolean;

	constructor(bcm: number, channel: number, onReleased: () => void) {
		this.bcm = bcm;
		this.channel = channel;
		this._onReleased = onReleased;
		this._frequency = DEFAULT_FREQUENCY;
		this._ratio = 0;
		this._polarity = "normal";
		this._enabled = false;
		this._released = false;
	}

	/** @internal apply the initial configuration. */
	_configure(config?: PwmChannelConfig): void {
		validatePwmChannelConfig(config);
		if (config?.frequency !== undefined) this._frequency = config.frequency;
		else if (config?.period !== undefined)
			this._frequency = 1e9 / config.period;
		if (config?.dutyCycle !== undefined) this._ratio = config.dutyCycle;
		if (config?.polarity !== undefined) this._polarity = config.polarity;
		this._enabled = config?.enabled ?? true;
	}

	async write(ratio: number): Promise<void> {
		validateDutyCycle(ratio);
		this._assertLive();
		this._ratio = ratio;
	}

	setDutyCycle(ratio: number): Promise<void> {
		return this.write(ratio);
	}

	async setFrequency(hz: number): Promise<void> {
		validateFrequency(hz);
		this._assertLive();
		this._frequency = hz;
	}

	async setPolarity(polarity: PwmPolarity): Promise<void> {
		this._assertLive();
		this._polarity = polarity;
	}

	async disable(): Promise<void> {
		this._assertLive();
		this._enabled = false;
	}

	async release(): Promise<void> {
		if (this._released) return;
		this._released = true;
		this._enabled = false;
		this._onReleased();
	}

	/** Test-only: the current frequency in Hz. */
	getFrequency(): number {
		return this._frequency;
	}

	/** Test-only: the current duty-cycle ratio (0..1). */
	getDutyCycle(): number {
		return this._ratio;
	}

	/** Test-only: whether output is currently enabled. */
	isEnabled(): boolean {
		return this._enabled;
	}

	/** Test-only: the current polarity. */
	getPolarity(): PwmPolarity {
		return this._polarity;
	}

	private _assertLive(): void {
		if (this._released)
			throw new Error(`PWM channel for BCM ${this.bcm} has been released`);
	}
}

export class MockPin implements IPin {
	public readonly bcm: number;
	public direction: PinDirection | null;

	private _level: boolean;
	private _output: boolean;
	private _edge: Edge | undefined;
	private _onChange: ((value: boolean, timestamp: bigint) => void) | undefined;
	private _pwmChannel: MockPwmChannel | undefined;
	private readonly _claimPwm: (bcm: number) => MockPwmChannel;

	constructor(bcm: number, claimPwm: (bcm: number) => MockPwmChannel) {
		this.bcm = bcm;
		this.direction = null;
		this._level = false;
		this._output = false;
		this._edge = undefined;
		this._onChange = undefined;
		this._pwmChannel = undefined;
		this._claimPwm = claimPwm;
	}

	async setInput(options?: PinInputOptions): Promise<void> {
		validatePinInputOptions(options);
		await this._teardownPwm();
		this._edge = options?.edge;
		this._onChange = options?.onChange;
		this.direction = "in";
	}

	async setOutput(options?: PinOutputOptions): Promise<void> {
		validatePinOutputOptions(options);
		await this._teardownPwm();
		this._edge = undefined;
		this._onChange = undefined;
		this._output = options?.initialValue ?? false;
		this.direction = "out";
	}

	async pwm(config?: PwmChannelConfig): Promise<IPwmChannel> {
		validatePwmChannelConfig(config);
		const channel = this._claimPwm(this.bcm);
		this._edge = undefined;
		this._onChange = undefined;
		this.direction = null;
		this._pwmChannel = channel;
		channel._configure(config);
		return channel;
	}

	async read(): Promise<boolean> {
		if (this.direction !== "in")
			throw new Error(`Pin ${this.bcm} is not configured as an input`);
		return this._level;
	}

	async write(value: boolean): Promise<void> {
		if (this.direction !== "out")
			throw new Error(`Pin ${this.bcm} is not configured as an output`);
		this._output = value;
	}

	async release(): Promise<void> {
		await this._teardownPwm();
		this.direction = null;
		this._onChange = undefined;
		this._edge = undefined;
	}

	/** Test-only: set the virtual input level, firing `onChange` on a matching edge. */
	driveInput(level: boolean): void {
		const previous = this._level;
		this._level = level;
		if (this.direction === "in" && this._edge && this._onChange) {
			if (edgeMatches(this._edge, previous, level)) {
				this._onChange(level, process.hrtime.bigint());
			}
		}
	}

	/** Test-only: the last value written to this (output) pin. */
	getOutput(): boolean {
		return this._output;
	}

	/** @internal invoked by MockGpio when this pin's PWM channel is released. */
	_onPwmReleased(): void {
		this._pwmChannel = undefined;
	}

	private async _teardownPwm(): Promise<void> {
		if (this._pwmChannel) await this._pwmChannel.release();
	}
}

export class MockGpio implements IGpio {
	private readonly _pins: Map<number, MockPin>;
	private readonly _pwmChannels: Map<number, MockPwmChannel>;

	constructor() {
		this._pins = new Map();
		this._pwmChannels = new Map();
	}

	/** No-op: there is no device to open. Present for `IGpio` parity. */
	async init(): Promise<void> {}

	pin(bcm: number): MockPin {
		validateBcm(bcm);
		let pin = this._pins.get(bcm);
		if (!pin) {
			pin = new MockPin(bcm, (b) => this._pwmClaim(b));
			this._pins.set(bcm, pin);
		}
		return pin;
	}

	async release(): Promise<void> {
		for (const channel of [...this._pwmChannels.values()]) {
			await channel.release();
		}
		this._pwmChannels.clear();
		for (const pin of this._pins.values()) {
			await pin.release();
		}
	}

	private _pwmClaim(bcm: number): MockPwmChannel {
		const channel = pwmChannelForBcm(bcm);
		const existing = this._pwmChannels.get(channel);
		if (existing) {
			if (existing.bcm !== bcm)
				throw new Error(
					`PWM channel ${channel} is already in use by BCM ${existing.bcm} ` +
						`(BCM ${bcm} shares it); release BCM ${existing.bcm} first`,
				);
			return existing;
		}
		const ch = new MockPwmChannel(bcm, channel, () => {
			this._pwmChannels.delete(channel);
			this._pins.get(bcm)?._onPwmReleased();
		});
		this._pwmChannels.set(channel, ch);
		return ch;
	}
}
