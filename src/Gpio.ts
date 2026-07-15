import { getNative } from "./native.js";
import { validateBcm, validateGpioOptions } from "./options.js";
import { Pin } from "./Pin.js";
import type {
	ChipInfo,
	GpioOptions,
	IGpio,
	INativeGpio,
	NativeLineConfig,
} from "./types.js";

const DEFAULT_CHIP = "/dev/gpiochip0";

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
		for (const gpio of liveInstances) gpio._closeNative();
	});
}

export class Gpio implements IGpio {
	private readonly _options: GpioOptions;
	private readonly _pins: Map<number, Pin>;
	private _native: INativeGpio | null;
	private _openPromise: Promise<void> | null;
	private _closed: boolean;

	constructor(options?: GpioOptions) {
		validateGpioOptions(options);
		this._options = options ?? {};
		this._pins = new Map();
		this._native = null;
		this._openPromise = null;
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
		return this._ensureOpen();
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
}
