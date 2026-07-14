// List the GPIO chips available on this machine and which one would be
// auto-detected as the 40-pin header.
//
//   bun examples/list-chips.ts
//   npx tsx examples/list-chips.ts
//
// In your own project the import is:  import { Gpio } from "@liminal-machines-co/gpio";
import { Gpio } from "../src/index.js";

async function main() {
	const chips = await Gpio.listChips();

	if (chips.length === 0) {
		console.log("No GPIO chips found.");
		return;
	}
	for (const c of chips) {
		console.log(`${c.path}  ${c.name}  ${c.label}  (${c.lines} lines)`);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
