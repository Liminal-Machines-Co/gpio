import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ChipInfo, INativeGpioClass } from "../../src/types.js";

export interface NativeModule {
	NativeGpio: INativeGpioClass;
	listChips(): ChipInfo[];
	detectHeaderChip?(): string | null;
}

// __dirname works in both Bun (injected) and tsc's CommonJS output.
const require = createRequire(__filename);
const root = resolve(__dirname, "..", "..");

/**
 * The raw native addon, loaded directly (not through the Gpio wrapper) so
 * integration tests can exercise the binding contract. Null when no prebuilt
 * binary is available — callers should skip.
 */
export const native: NativeModule | null = (() => {
	try {
		return require("node-gyp-build")(root) as NativeModule;
	} catch {
		return null;
	}
})();

const CONFIGFS_ROOT = "/sys/kernel/config/gpio-sim";

/**
 * True when this host can actually drive `gpio-sim`: Linux, running as root,
 * the `gpio-sim` kernel module loaded (or built-in), and configfs mounted at
 * `/sys/kernel/config`. On macOS (and any Linux host missing one of those
 * pieces) this is false and integration tests self-skip, mirroring the
 * serial suite's `hasSocat` check.
 */
export function gpioSimAvailable(): boolean {
	if (process.platform !== "linux") return false;
	if (typeof process.getuid !== "function" || process.getuid() !== 0)
		return false;
	if (!existsSync(CONFIGFS_ROOT)) return false;
	try {
		// /sys/kernel/config/gpio-sim is only populated once the gpio-sim
		// module is loaded; a bare configfs mount without it won't have this.
		readFileSync(`${CONFIGFS_ROOT}/../../../modules/gpio_sim`, "utf8");
		return true;
	} catch {
		// The above path is a best-effort probe; configfs directory existing
		// is itself a reasonable signal the module is present, so fall back
		// to that instead of hard-failing on the modules check.
		return existsSync(CONFIGFS_ROOT);
	}
}

export interface SimChip {
	/** Absolute character device path, e.g. "/dev/gpiochip5". */
	path: string;
	/** Number of simulated lines. */
	lines: number;
	/** configfs bank directory for driving lines via `pull`. */
	bankDir: string;
	/** Tear down the configfs bank, removing the simulated chip. */
	teardown(): Promise<void>;
}

/**
 * Creates a virtual gpiochip via the kernel `gpio-sim` configfs interface.
 * Requires `gpioSimAvailable()` to be true (Linux + root + module loaded).
 *
 * Configfs layout:
 *   /sys/kernel/config/gpio-sim/<name>/
 *     dev_name              -> read after `live` is enabled to find gpiochipN
 *     live                  -> "1" instantiates the device
 *     bank0/num_lines        -> line count
 *     bank0/lineN/name       -> optional per-line name
 *     bank0/lineN/pull        -> "pull-up" | "pull-down" (drive line N from userspace)
 */
export async function makeSimChip(
	lineCount = 8,
	name = `liminal-gpio-test-${process.pid}`,
): Promise<SimChip> {
	const chipDir = `${CONFIGFS_ROOT}/${name}`;
	const bankDir = `${chipDir}/bank0`;

	await mkdir(bankDir, { recursive: true });
	await writeFile(`${bankDir}/num_lines`, String(lineCount));
	await writeFile(`${chipDir}/live`, "1");

	// After `live` flips to 1, the kernel creates /sys/.../<name>/gpiochipN
	// and dev_name records its name.
	const entries = await readdir(chipDir);
	const chipEntry = entries.find((e) => e.startsWith("gpiochip"));
	if (!chipEntry) {
		throw new Error(`gpio-sim: chip device did not appear under ${chipDir}`);
	}

	const teardown = async () => {
		try {
			await writeFile(`${chipDir}/live`, "0");
		} catch {
			// already torn down
		}
		await rm(chipDir, { recursive: true, force: true });
	};

	return {
		path: `/dev/${chipEntry}`,
		lines: lineCount,
		bankDir,
		teardown,
	};
}

/** Drive a simulated input line's pull from userspace (the "peer" side). */
export async function pullLine(
	chip: SimChip,
	offset: number,
	pull: "pull-up" | "pull-down",
): Promise<void> {
	await writeFile(`${chip.bankDir}/line${offset}/pull`, pull);
}
