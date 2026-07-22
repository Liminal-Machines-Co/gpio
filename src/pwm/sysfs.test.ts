import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exportChannel,
	listPwmChips,
	probePwm,
	readAttr,
	resolvePwmChip,
	unexportChannel,
	writeAttr,
} from "./sysfs.js";

// Skip permission-denied assertions when running as root (e.g. the integration
// CI job), where chmod 0444 does not actually block writes.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let base: string;

async function makeChip(name: string, npwm: number): Promise<string> {
	const path = join(base, name);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "npwm"), `${npwm}\n`);
	await writeFile(join(path, "export"), "");
	await writeFile(join(path, "unexport"), "");
	return path;
}

async function makeChannelDir(
	chipPath: string,
	channel: number,
): Promise<void> {
	const dir = join(chipPath, `pwm${channel}`);
	await mkdir(dir, { recursive: true });
	for (const attr of ["period", "duty_cycle", "polarity", "enable"]) {
		await writeFile(join(dir, attr), "");
	}
}

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "pwm-sysfs-"));
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("writeAttr / readAttr", () => {
	test("writes and reads back a trimmed value", async () => {
		const chip = await makeChip("pwmchip0", 2);
		await makeChannelDir(chip, 0);
		await writeAttr(chip, "pwm0/period", "1000000");
		expect(await readAttr(chip, "pwm0/period")).toBe("1000000");
	});

	test.skipIf(isRoot)(
		"remaps EACCES to a branded permission error",
		async () => {
			const chip = await makeChip("pwmchip0", 2);
			await makeChannelDir(chip, 0);
			await chmod(join(chip, "pwm0/period"), 0o444);
			await expect(writeAttr(chip, "pwm0/period", "1")).rejects.toThrow(
				/permission denied/i,
			);
		},
	);
});

describe("exportChannel", () => {
	test("writes the channel and resolves once the dir is writable", async () => {
		const chip = await makeChip("pwmchip0", 2);
		await makeChannelDir(chip, 0);
		await exportChannel(chip, 0);
		expect(await readAttr(chip, "export")).toBe("0");
	});

	test("waits for a channel dir that appears slightly later", async () => {
		const chip = await makeChip("pwmchip0", 2);
		setTimeout(() => void makeChannelDir(chip, 1), 40);
		await exportChannel(chip, 1); // resolves via the retry loop
		expect(await readAttr(chip, "export")).toBe("1");
	});
});

describe("unexportChannel", () => {
	test("writes the channel to unexport", async () => {
		const chip = await makeChip("pwmchip0", 2);
		await unexportChannel(chip, 0);
		expect(await readAttr(chip, "unexport")).toBe("0");
	});

	test("swallows a missing chip (ENOENT)", async () => {
		await expect(
			unexportChannel(join(base, "nope"), 0),
		).resolves.toBeUndefined();
	});
});

describe("listPwmChips", () => {
	test("enumerates chips with npwm, sorted", async () => {
		await makeChip("pwmchip1", 4);
		await makeChip("pwmchip0", 2);
		const chips = await listPwmChips(base);
		expect(chips.map((c) => c.name)).toEqual(["pwmchip0", "pwmchip1"]);
		expect(chips[0].npwm).toBe(2);
		expect(chips[1].npwm).toBe(4);
	});

	test("returns [] when the base directory is missing", async () => {
		expect(await listPwmChips(join(base, "missing"))).toEqual([]);
	});
});

describe("resolvePwmChip", () => {
	test("returns the sole chip", async () => {
		const chip = await makeChip("pwmchip0", 2);
		expect(await resolvePwmChip({ base })).toBe(chip);
	});

	test("throws overlay guidance when no chip exists", async () => {
		await expect(resolvePwmChip({ base })).rejects.toThrow(
			/dtoverlay=pwm-2chan/,
		);
	});

	test("throws when multiple chips are present", async () => {
		await makeChip("pwmchip0", 2);
		await makeChip("pwmchip1", 4);
		await expect(resolvePwmChip({ base })).rejects.toThrow(
			/multiple PWM chips/,
		);
	});

	test("honors an explicit chip name", async () => {
		await makeChip("pwmchip0", 2);
		await makeChip("pwmchip1", 4);
		expect(await resolvePwmChip({ base, chip: "pwmchip1" })).toBe(
			join(base, "pwmchip1"),
		);
	});

	test("honors an explicit absolute chip path", async () => {
		expect(await resolvePwmChip({ base, chip: "/custom/pwmchipX" })).toBe(
			"/custom/pwmchipX",
		);
	});
});

describe("probePwm", () => {
	test("reports available when export is writable", async () => {
		await makeChip("pwmchip0", 2);
		expect(await probePwm({ base })).toEqual({
			available: true,
			chipPath: join(base, "pwmchip0"),
		});
	});

	test("reports no-chip when nothing is present", async () => {
		expect(await probePwm({ base })).toEqual({
			available: false,
			reason: "no-chip",
		});
	});

	test.skipIf(isRoot)(
		"reports no-permission when export is read-only",
		async () => {
			const chip = await makeChip("pwmchip0", 2);
			await chmod(join(chip, "export"), 0o444);
			const probe = await probePwm({ base });
			expect(probe).toEqual({
				available: false,
				reason: "no-permission",
				chipPath: chip,
			});
		},
	);
});
