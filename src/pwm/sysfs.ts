// Low-level hardware-PWM backend over the kernel sysfs interface
// (/sys/class/pwm/pwmchipN/...). Pure Node fs — no native code.
//
// The base path is a parameter (default "/sys/class/pwm") so unit tests can
// point the exact same code at a fake chip tree in a temp directory.

import { constants as fsConstants } from "node:fs";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PwmChipInfo } from "../types.js";

export const DEFAULT_BASE = "/sys/class/pwm";

// How long to wait for `export` to materialize a writable channel directory
// (the kernel creates pwmN/ asynchronously and udev may still be fixing up its
// group ownership, so a fresh export is briefly not group-writable).
const EXPORT_WAIT_MS = 1000;
const EXPORT_POLL_MS = 20;

const BRAND = "@liminal-machines-co/gpio";

function errno(err: unknown): string | undefined {
	return err && typeof err === "object" && "code" in err
		? (err as { code?: string }).code
		: undefined;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Remap a raw fs error into a branded, actionable message. */
function remapWriteError(err: unknown, path: string): Error {
	const code = errno(err);
	if (code === "EACCES" || code === "EPERM")
		return new Error(
			`${BRAND}: permission denied writing PWM sysfs (${path}). Run as root, ` +
				"or add your user to the 'gpio' group and ensure the udev rule that " +
				"grants PWM access is installed.",
			{ cause: err },
		);
	return new Error(
		`${BRAND}: failed writing PWM sysfs (${path}): ${String(err)}`,
		{
			cause: err,
		},
	);
}

/** Remap a missing-chip error into overlay-setup guidance. */
function remapMissingChip(err: unknown, base: string): Error {
	return new Error(
		`${BRAND}: no PWM chip found under ${base}. Enable hardware PWM with ` +
			"'dtoverlay=pwm-2chan' in /boot/firmware/config.txt (older Pi OS: " +
			"/boot/config.txt) and reboot.",
		{ cause: err },
	);
}

/** Write a value to a sysfs attribute under a chip directory. */
export async function writeAttr(
	chipPath: string,
	rel: string,
	value: string,
): Promise<void> {
	const path = join(chipPath, rel);
	try {
		await writeFile(path, value);
	} catch (err) {
		throw remapWriteError(err, path);
	}
}

/** Read (and trim) a sysfs attribute under a chip directory. */
export async function readAttr(chipPath: string, rel: string): Promise<string> {
	const path = join(chipPath, rel);
	const raw = await readFile(path, "utf8");
	return raw.trim();
}

/**
 * Export a channel and wait until its attribute directory is writable. EBUSY
 * (already exported) is treated as success — export is idempotent here.
 */
export async function exportChannel(
	chipPath: string,
	channel: number,
): Promise<void> {
	const exportPath = join(chipPath, "export");
	try {
		await writeFile(exportPath, String(channel));
	} catch (err) {
		if (errno(err) !== "EBUSY") throw remapWriteError(err, exportPath);
	}

	// Poll for pwmN/period becoming writable (dir appears + udev fixes perms).
	const probe = join(chipPath, `pwm${channel}`, "period");
	const deadline = Date.now() + EXPORT_WAIT_MS;
	let lastErr: unknown;
	for (;;) {
		try {
			await access(probe, fsConstants.W_OK);
			return;
		} catch (err) {
			lastErr = err;
		}
		if (Date.now() >= deadline) break;
		await sleep(EXPORT_POLL_MS);
	}
	throw remapWriteError(lastErr, probe);
}

/** Best-effort unexport; missing/invalid channel is not an error. */
export async function unexportChannel(
	chipPath: string,
	channel: number,
): Promise<void> {
	try {
		await writeFile(join(chipPath, "unexport"), String(channel));
	} catch (err) {
		const code = errno(err);
		// Already unexported (EINVAL) or the chip is gone (ENOENT): nothing to do.
		if (code === "EINVAL" || code === "ENOENT") return;
		throw remapWriteError(err, join(chipPath, "unexport"));
	}
}

/** Enumerate PWM chips under the base directory. */
export async function listPwmChips(
	base: string = DEFAULT_BASE,
): Promise<PwmChipInfo[]> {
	let names: string[];
	try {
		names = await readdir(base);
	} catch (err) {
		if (errno(err) === "ENOENT") return [];
		throw err;
	}
	const chips: PwmChipInfo[] = [];
	for (const name of names.sort()) {
		if (!name.startsWith("pwmchip")) continue;
		const path = join(base, name);
		let npwm = 0;
		try {
			npwm = Number.parseInt(await readAttr(path, "npwm"), 10) || 0;
		} catch {
			// Unreadable npwm — still report the chip with npwm 0.
		}
		chips.push({ path, name, npwm });
	}
	return chips;
}

/** Result of a non-throwing PWM capability probe (see `probePwm`). */
export type PwmProbe =
	| { available: true; chipPath: string }
	| {
			available: false;
			reason: "no-chip" | "no-permission";
			chipPath?: string;
	  };

/**
 * Non-throwing check of whether hardware PWM is usable: a chip exists and its
 * `export` attribute is writable by this process. Used by `Gpio.init()` to warn
 * (never throw) with actionable guidance.
 */
export async function probePwm(opts?: {
	base?: string;
	chip?: string;
}): Promise<PwmProbe> {
	let chipPath: string;
	try {
		chipPath = await resolvePwmChip(opts);
	} catch {
		return { available: false, reason: "no-chip" };
	}
	try {
		await access(join(chipPath, "export"), fsConstants.W_OK);
		return { available: true, chipPath };
	} catch (err) {
		if (errno(err) === "ENOENT") return { available: false, reason: "no-chip" };
		return { available: false, reason: "no-permission", chipPath };
	}
}

/**
 * Resolve the PWM chip to use. An explicit `chip` (name or absolute path)
 * overrides discovery; otherwise pick the sole chip. Throws a branded,
 * actionable error when discovery is ambiguous or finds nothing.
 */
export async function resolvePwmChip(opts?: {
	base?: string;
	chip?: string;
}): Promise<string> {
	const base = opts?.base ?? DEFAULT_BASE;
	if (opts?.chip) {
		return opts.chip.startsWith("/") ? opts.chip : join(base, opts.chip);
	}
	const chips = await listPwmChips(base);
	if (chips.length === 0) throw remapMissingChip(undefined, base);
	if (chips.length > 1)
		throw new Error(
			`${BRAND}: multiple PWM chips found under ${base} ` +
				`(${chips.map((c) => c.name).join(", ")}); pass { pwmChip } to choose one.`,
		);
	return chips[0].path;
}
