// Watch a push-button on an input pin and log each edge with its timestamp.
//
//   bun examples/button.ts 27
//   GPIO_PIN=27 bun examples/button.ts
//
// In your own project the import is:  import { Gpio } from "@liminal-machines-co/gpio";
import { Gpio } from "../src/index.js";

async function main() {
	const bcm = Number(process.argv[2] ?? process.env.GPIO_PIN ?? 27);

	const gpio = new Gpio();
	const button = gpio.pin(bcm);

	// pullup + a button wired to ground: idle high, low while pressed.
	await button.setInput({
		pullup: true,
		edge: "both",
		debounce: 5000, // microseconds
		onChange: (value, timestamp) => {
			console.log(`BCM ${bcm} -> ${value ? "high" : "low"} @ ${timestamp}ns`);
		},
	});

	console.log(`watching BCM ${bcm} — press Ctrl+C to quit`);

	process.on("SIGINT", async () => {
		await gpio.release();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
