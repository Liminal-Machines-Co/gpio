import { expect, test } from "bun:test";
import {
	gpioSimAvailable,
	makeSimChip,
	native,
	pullLine,
	type SimChip,
} from "../helpers/gpio-sim.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unavailable = !gpioSimAvailable() || !native?.NativeGpio;

test.skipIf(unavailable)(
	"native open/requestLine/read/write over a gpio-sim chip",
	async () => {
		if (!native) return; // unreachable when not skipped; narrows the type
		let chip: SimChip | undefined;
		try {
			chip = await makeSimChip(4);

			const gpio = new native.NativeGpio();
			gpio.open(chip.path, () => {});

			// Configure line 0 as output, line 1 as input.
			gpio.requestLine(0, { direction: "out", initialValue: false });
			gpio.requestLine(1, { direction: "in" });

			await gpio.writeLine(0, true);
			expect(await gpio.readLine(0)).toBe(true);

			await gpio.writeLine(0, false);
			expect(await gpio.readLine(0)).toBe(false);

			gpio.releaseLine(0);
			gpio.releaseLine(1);
			gpio.close(); // must join the poll thread without hanging
		} finally {
			await chip?.teardown();
		}
	},
);

test.skipIf(unavailable)(
	"edge events: onChange fires with a boolean value and bigint timestamp",
	async () => {
		if (!native) return; // unreachable when not skipped; narrows the type
		let chip: SimChip | undefined;
		try {
			chip = await makeSimChip(4);

			const events: { offset: number; value: boolean; timestamp: bigint }[] =
				[];
			const gpio = new native.NativeGpio();
			gpio.open(chip.path, (offset, value, timestamp) => {
				events.push({ offset, value, timestamp });
			});

			gpio.requestLine(2, { direction: "in", edge: "both", pulldown: true });
			await sleep(100);

			await pullLine(chip, 2, "pull-up");
			await sleep(200);
			await pullLine(chip, 2, "pull-down");
			await sleep(200);

			expect(events.length).toBeGreaterThanOrEqual(1);
			const first = events[0];
			expect(typeof first.value).toBe("boolean");
			expect(typeof first.timestamp).toBe("bigint");

			gpio.releaseLine(2);
			gpio.close();
		} finally {
			await chip?.teardown();
		}
	},
);
