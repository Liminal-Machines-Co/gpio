#!/usr/bin/env node
import { createRequire } from "node:module";

const HELP = `liminal-gpio — Raspberry Pi GPIO control

Usage:
  liminal-gpio info                 List available GPIO chips
  liminal-gpio read <bcm>           Read the current value of a pin
  liminal-gpio write <bcm> <0|1>    Write a value to a pin
  liminal-gpio pwm <bcm> <duty>     Drive a hardware-PWM pin (duty 0..1)
  liminal-gpio --help               Show this help
  liminal-gpio --version            Show the version

Note: this CLI is stubbed in v1 — it describes the intended behavior of each
command but does not yet touch hardware. Use the library API (Gpio/Pin)
directly for now.
`;

function version(): string {
	try {
		const require = createRequire(__filename);
		return require("../package.json").version as string;
	} catch {
		return "unknown";
	}
}

async function main(argv: string[]): Promise<number> {
	const args = argv.slice(2);

	if (args.includes("-h") || args.includes("--help")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (args.includes("--version") || args.includes("-v")) {
		process.stdout.write(`${version()}\n`);
		return 0;
	}

	const [cmd, ...rest] = args.filter((a) => !a.startsWith("-"));

	switch (cmd) {
		case undefined:
		case "info": {
			process.stdout.write(
				"liminal-gpio info: would list available GPIO chips (via Gpio.listChips()). " +
					"(not implemented in v1)\n",
			);
			return 0;
		}
		case "read": {
			const bcm = rest[0];
			if (bcm === undefined) {
				process.stderr.write("liminal-gpio: read requires a <bcm> argument\n");
				return 1;
			}
			process.stdout.write(
				`liminal-gpio read: would configure BCM ${bcm} as an input and read its value. ` +
					"(not implemented in v1)\n",
			);
			return 1;
		}
		case "write": {
			const [bcm, value] = rest;
			if (bcm === undefined || value === undefined) {
				process.stderr.write(
					"liminal-gpio: write requires <bcm> and <0|1> arguments\n",
				);
				return 1;
			}
			process.stdout.write(
				`liminal-gpio write: would configure BCM ${bcm} as an output and write ${value}. ` +
					"(not implemented in v1)\n",
			);
			return 1;
		}
		case "pwm": {
			const [bcm, duty] = rest;
			if (bcm === undefined || duty === undefined) {
				process.stderr.write(
					"liminal-gpio: pwm requires <bcm> and <duty 0..1> arguments\n",
				);
				return 1;
			}
			process.stdout.write(
				`liminal-gpio pwm: would drive BCM ${bcm} at duty ${duty} via hardware PWM. ` +
					"(not implemented in v1)\n",
			);
			return 1;
		}
		default: {
			process.stderr.write(`liminal-gpio: unknown command '${cmd}'\n\n${HELP}`);
			return 1;
		}
	}
}

main(process.argv)
	.then((code) => process.exit(code))
	.catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`liminal-gpio: ${msg}\n`);
		process.exit(1);
	});
