import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	validateDutyCycle,
	validateFrequency,
	validatePwmChannelConfig,
} from "./options.js";
import { exportChannel, unexportChannel, writeAttr } from "./pwm/sysfs.js";
import type { IPwmChannel, PwmChannelConfig, PwmPolarity } from "./types.js";

// Default period when a channel is first configured without a frequency or
// period — 1 kHz is a sane, flicker-free default for LEDs.
const DEFAULT_PERIOD_NS = 1_000_000;

function clampDutyNs(ratio: number, periodNs: number): number {
	return Math.min(Math.max(Math.round(ratio * periodNs), 0), periodNs);
}

/**
 * A single hardware-PWM channel over sysfs. Created and cached by `Gpio`, and
 * handed back through `pin.pwm()`. Owns the sysfs write ordering (kernel
 * requires `duty_cycle <= period`, and polarity changes only while disabled).
 */
export class PwmChannel implements IPwmChannel {
	public readonly bcm: number;
	public readonly channel: number;

	private readonly _chipPath: string;
	private readonly _onReleased: () => void;

	private _periodNs: number;
	private _ratio: number;
	private _polarity: PwmPolarity;
	private _enabled: boolean;
	private _exported: boolean;
	private _released: boolean;

	/** @internal constructed by Gpio._pwmClaim. */
	constructor(
		chipPath: string,
		bcm: number,
		channel: number,
		onReleased: () => void,
	) {
		this._chipPath = chipPath;
		this.bcm = bcm;
		this.channel = channel;
		this._onReleased = onReleased;
		this._periodNs = DEFAULT_PERIOD_NS;
		this._ratio = 0;
		this._polarity = "normal";
		this._enabled = false;
		this._exported = false;
		this._released = false;
	}

	/** @internal export + apply the initial configuration. */
	async _configure(config?: PwmChannelConfig): Promise<void> {
		validatePwmChannelConfig(config);
		this._assertLive();

		await exportChannel(this._chipPath, this.channel);
		this._exported = true;

		if (config?.frequency !== undefined)
			this._periodNs = Math.round(1e9 / config.frequency);
		else if (config?.period !== undefined)
			this._periodNs = Math.round(config.period);
		if (config?.dutyCycle !== undefined) this._ratio = config.dutyCycle;

		// Polarity is only writable while the output is disabled — and it is,
		// since we haven't enabled yet on a fresh export.
		if (config?.polarity !== undefined && config.polarity !== this._polarity) {
			await writeAttr(this._chipPath, `pwm${this.channel}/enable`, "0");
			await writeAttr(
				this._chipPath,
				`pwm${this.channel}/polarity`,
				config.polarity,
			);
			this._polarity = config.polarity;
		}

		await this._applyTiming(this._periodNs, this._ratio);

		const enable = config?.enabled ?? true;
		await this._writeEnable(enable);
	}

	async write(ratio: number): Promise<void> {
		validateDutyCycle(ratio);
		this._assertLive();
		this._ratio = ratio;
		await this._writeDuty();
	}

	setDutyCycle(ratio: number): Promise<void> {
		return this.write(ratio);
	}

	async setFrequency(hz: number): Promise<void> {
		validateFrequency(hz);
		this._assertLive();
		const period = Math.round(1e9 / hz);
		await this._applyTiming(period, this._ratio);
		this._periodNs = period;
	}

	async setPolarity(polarity: PwmPolarity): Promise<void> {
		this._assertLive();
		if (polarity === this._polarity) return;
		const wasEnabled = this._enabled;
		if (wasEnabled) await this._writeEnable(false);
		await writeAttr(this._chipPath, `pwm${this.channel}/polarity`, polarity);
		this._polarity = polarity;
		if (wasEnabled) await this._writeEnable(true);
	}

	async disable(): Promise<void> {
		this._assertLive();
		await this._writeEnable(false);
	}

	async release(): Promise<void> {
		if (this._released) return;
		this._released = true;
		if (this._exported) {
			try {
				await writeAttr(this._chipPath, `pwm${this.channel}/enable`, "0");
			} catch {
				// Best-effort: still attempt to unexport below.
			}
			await unexportChannel(this._chipPath, this.channel);
			this._exported = false;
		}
		this._onReleased();
	}

	/** @internal best-effort synchronous cleanup for the process-exit hook. */
	_unexportSync(): void {
		if (!this._exported || this._released) return;
		try {
			writeFileSync(join(this._chipPath, `pwm${this.channel}/enable`), "0");
		} catch {
			// ignore — exiting anyway
		}
		try {
			writeFileSync(join(this._chipPath, "unexport"), String(this.channel));
		} catch {
			// ignore — exiting anyway
		}
	}

	private async _writeEnable(on: boolean): Promise<void> {
		await writeAttr(
			this._chipPath,
			`pwm${this.channel}/enable`,
			on ? "1" : "0",
		);
		this._enabled = on;
	}

	private async _writeDuty(): Promise<void> {
		const duty = clampDutyNs(this._ratio, this._periodNs);
		await writeAttr(
			this._chipPath,
			`pwm${this.channel}/duty_cycle`,
			String(duty),
		);
	}

	// Change period safely: the kernel rejects a period below the current
	// duty_cycle, so drop duty to 0 first, then set period, then restore duty.
	private async _applyTiming(periodNs: number, ratio: number): Promise<void> {
		this._ratio = ratio;
		await writeAttr(this._chipPath, `pwm${this.channel}/duty_cycle`, "0");
		await writeAttr(
			this._chipPath,
			`pwm${this.channel}/period`,
			String(periodNs),
		);
		this._periodNs = periodNs;
		await this._writeDuty();
	}

	private _assertLive(): void {
		if (this._released)
			throw new Error(`PWM channel for BCM ${this.bcm} has been released`);
	}
}
