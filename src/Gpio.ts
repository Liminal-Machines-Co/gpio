import { getNative } from "./native.js";
import {
	pwmChannelForBcm,
	validateBcm,
	validateGpioOptions,
} from "./options.js";
import { Pin } from "./Pin.js";
import { PwmChannel } from "./PwmChannel.js";
import { probePwm, resolvePwmChip } from "./pwm/sysfs.js";
import type {
	ChipInfo,
	GpioOptions,
	IGpio,
	INativeGpio,
	NativeLineConfig,
} from "./types.js";

const DEFAULT_CHIP = "/dev/gpiochip0";

// One-time-per-process guard for the PWM capability warning emitted by init().
let pwmCapabilityWarned = false;

async function warnPwmCapability(pwmChip?: string): Promise<void> {
	if (pwmCapabilityWarned || process.platform !== "linux") return;
	let probe: Awaited<ReturnType<typeof probePwm>>;
	try {
		probe = await probePwm({ chip: pwmChip });
	} catch {
		return; // never let the probe interfere with init()
	}
	if (probe.available) return;
	pwmCapabilityWarned = true;
	if (probe.reason === "no-permission") {
		console.warn(
			"@liminal-machines-co/gpio: hardware PWM is present but not writable by " +
				"this user, so pin.pwm() will fail unless you run as root.\n" +
				"To grant access without root, run:\n\n" +
				"    sudo usermod -aG gpio $(whoami)\n\n" +
				"then log out and back in (or reboot) for it to take effect.",
		);
	} else {
		console.warn(
			"@liminal-machines-co/gpio: hardware PWM is not enabled, so pin.pwm() is " +
				"unavailable.\nTo enable it, add:\n\n" +
				"    dtoverlay=pwm-2chan\n\n" +
				"to /boot/firmware/config.txt (older Pi OS: /boot/config.txt) and reboot.",
		);
	}
}

function normalizeChipPath(chip: string): string {
	return chip.startsWith("/dev/") ? chip : `/dev/${chip}`;
}

// One shared exit listener for every live Gpio. A per-instance
// process.on("exit") listener would grow the listener list without bound and
// pin each un-released instance (and its native handle) for the process
// lifetime.
const liveInstances = new Set<Gpio>();
let exitHookInstalled = false;

function ensureExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		// Best-effort synchronous cleanup on process exit; the native
		// finalizer is the real safety net for anything this misses.
		for (const gpio of liveInstances) {
			gpio._closeNative();
			gpio._unexportPwmSync();
		}
	});
}

export class Gpio implements IGpio {
	private readonly _options: GpioOptions;
	private readonly _pins: Map<number, Pin>;
	private readonly _pwmChannels: Map<number, PwmChannel>;
	private _native: INativeGpio | null;
	private _openPromise: Promise<void> | null;
	private _pwmOpenPromise: Promise<string> | null;
	private _closed: boolean;

	constructor(options?: GpioOptions) {
		validateGpioOptions(options);
		this._options = options ?? {};
		this._pins = new Map();
		this._pwmChannels = new Map();
		this._native = null;
		this._openPromise = null;
		this._pwmOpenPromise = null;
		this._closed = false;
		liveInstances.add(this);
		ensureExitHook();
	}

	/**
	 * Optionally open the chip up front to fail fast on a missing device or
	 * insufficient permissions. Skipping it is fine — the chip is opened
	 * lazily on the first pin configuration. Idempotent.
	 */
	async init(): Promise<void> {
		await this._ensureOpen();
		// Non-fatal: we don't know whether the caller will use PWM, so surface a
		// one-time actionable warning rather than throwing.
		await warnPwmCapability(this._options.pwmChip);
	}

	pin(bcm: number): Pin {
		validateBcm(bcm);
		let pin = this._pins.get(bcm);
		if (!pin) {
			pin = new Pin(this, bcm);
			this._pins.set(bcm, pin);
		}
		return pin;
	}

	async release(): Promise<void> {
		if (this._closed) return;
		this._closed = true;
		// An _open() may still be mid-flight; wait for it so the native handle
		// it produces is the one closed below rather than leaked.
		await this._openPromise?.catch(() => {});
		await this._pwmOpenPromise?.catch(() => {});
		// Copy first: each release() calls back into _pwmChannels.delete.
		for (const channel of [...this._pwmChannels.values()]) {
			await channel.release();
		}
		this._pwmChannels.clear();
		for (const pin of this._pins.values()) {
			await pin.release();
		}
		this._pins.clear();
		this._native?.close();
		this._native = null;
		liveInstances.delete(this);
	}

	/** @internal shared process-exit hook cleanup. */
	_closeNative(): void {
		this._native?.close();
	}

	/** @internal best-effort synchronous PWM unexport on process exit. */
	_unexportPwmSync(): void {
		for (const channel of this._pwmChannels.values()) channel._unexportSync();
	}

	static async listChips(): Promise<ChipInfo[]> {
		const { listChips } = await getNative();
		return listChips();
	}

	/** @internal idempotent, memoized chip-open used by Pin before any native call. */
	_ensureOpen(): Promise<void> {
		if (this._closed) throw new Error("Gpio has been released");
		if (!this._openPromise) {
			this._openPromise = this._open();
		}
		return this._openPromise;
	}

	private async _open(): Promise<void> {
		const native = await getNative();
		const chipPath = await this._resolveChipPath(native);
		const gpio = new native.NativeGpio();
		gpio.open(chipPath, (offset, value, timestamp) => {
			this._pins.get(offset)?._emit(value, timestamp);
		});
		if (this._closed) {
			// released while opening — close now instead of leaking the chip
			// fd and its threadsafe function (which also keeps the loop alive)
			gpio.close();
			throw new Error("Gpio has been released");
		}
		this._native = gpio;
	}

	private async _resolveChipPath(
		native: Awaited<ReturnType<typeof getNative>>,
	): Promise<string> {
		if (this._options.chip) return normalizeChipPath(this._options.chip);
		// detectHeaderChip is an optional native export (added alongside the
		// native GPIO backend); fall back gracefully when it isn't present.
		const detect = (native as Record<string, unknown>).detectHeaderChip as
			| (() => string | null)
			| undefined;
		if (typeof detect === "function") {
			const detected = detect();
			if (detected) return normalizeChipPath(detected);
		}
		return DEFAULT_CHIP;
	}

	/** @internal used by Pin. */
	_requestLine(offset: number, config: NativeLineConfig): void {
		this._native?.requestLine(offset, config);
	}

	/** @internal used by Pin. */
	_setConfig(offset: number, config: NativeLineConfig): void {
		this._native?.setConfig(offset, config);
	}

	/** @internal used by Pin. */
	_readLine(offset: number): Promise<boolean> {
		if (!this._native) throw new Error("Gpio is not open");
		return this._native.readLine(offset);
	}

	/** @internal used by Pin. */
	_writeLine(offset: number, value: boolean): Promise<void> {
		if (!this._native) throw new Error("Gpio is not open");
		return this._native.writeLine(offset, value);
	}

	/** @internal used by Pin. */
	_releaseLine(offset: number): void {
		this._native?.releaseLine(offset);
	}

	/** @internal idempotent, memoized PWM chip resolution. */
	_ensurePwmOpen(): Promise<string> {
		if (this._closed) throw new Error("Gpio has been released");
		if (!this._pwmOpenPromise) {
			this._pwmOpenPromise = resolvePwmChip({ chip: this._options.pwmChip });
		}
		return this._pwmOpenPromise;
	}

	/**
	 * @internal Claim (or reuse) the PWM channel for a BCM pin. Throws if the
	 * channel is already held by its sibling pin (12/18 share ch0, 13/19 ch1).
	 */
	async _pwmClaim(bcm: number): Promise<PwmChannel> {
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
		const chipPath = await this._ensurePwmOpen();
		const ch = new PwmChannel(chipPath, bcm, channel, () => {
			this._pwmChannels.delete(channel);
			this._pins.get(bcm)?._onPwmReleased();
		});
		this._pwmChannels.set(channel, ch);
		return ch;
	}
}
