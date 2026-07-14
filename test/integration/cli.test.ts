import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve(__dirname, "..", "..", "src", "cli.ts");
const run = (...args: string[]) =>
	spawnSync("bun", [cli, ...args], { encoding: "utf8" });

test("`--help` prints usage and exits 0", () => {
	const res = run("--help");
	expect(res.status).toBe(0);
	expect(res.stdout).toContain("liminal-gpio");
	expect(res.stdout).toContain("info");
	expect(res.stdout).toContain("read");
	expect(res.stdout).toContain("write");
});

test("`--version` prints a version string and exits 0", () => {
	const res = run("--version");
	expect(res.status).toBe(0);
	expect(res.stdout.trim().length).toBeGreaterThan(0);
});

test("`info` prints the stub message and exits 0", () => {
	const res = run("info");
	expect(res.status).toBe(0);
	expect(res.stdout).toContain("not implemented in v1");
});

test("`read <bcm>` prints the stub message and exits 1", () => {
	const res = run("read", "17");
	expect(res.status).toBe(1);
	expect(res.stdout).toContain("BCM 17");
	expect(res.stdout).toContain("not implemented in v1");
});

test("`write <bcm> <value>` prints the stub message and exits 1", () => {
	const res = run("write", "17", "1");
	expect(res.status).toBe(1);
	expect(res.stdout).toContain("BCM 17");
	expect(res.stdout).toContain("not implemented in v1");
});

test("an unknown command exits non-zero", () => {
	const res = run("bogus");
	expect(res.status).toBe(1);
});
