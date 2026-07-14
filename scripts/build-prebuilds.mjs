// Cross-compiles the native addon for every distributed target into
// ./prebuilds/<platform>-<arch>/serial.node. Zig cross-compiles all targets
// from a single host, so CI needs only one runner. Pass target triples as args
// to build a subset, otherwise all are built.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const TARGETS = [
	"aarch64-macos", // darwin-arm64
	"x86_64-macos", // darwin-x64
	"x86_64-linux-gnu", // linux-x64
	"aarch64-linux-gnu", // linux-arm64
	"x86_64-windows", // win32-x64
];

const targets = process.argv.slice(2);
const selected = targets.length > 0 ? targets : TARGETS;

let failed = false;
for (const target of selected) {
	console.log(`\n▶ building ${target}`);
	const res = spawnSync(
		"zig",
		["build", "--prefix", ".", "-Doptimize=ReleaseFast", `-Dtarget=${target}`],
		{ stdio: "inherit" },
	);
	if (res.status !== 0) {
		console.error(`✗ failed: ${target}`);
		failed = true;
	}
}

// Windows ReleaseFast still emits a .pdb; keep only the .node in prebuilds.
for (const arch of ["win32-x64", "win32-arm64", "win32-ia32"]) {
	rmSync(`prebuilds/${arch}/serial.pdb`, { force: true });
}

process.exit(failed ? 1 : 0);
