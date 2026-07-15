// Blink an LED wired to a GPIO pin (output on/off on an interval).
//
//   bun examples/blink.ts 17
//   GPIO_PIN=17 bun examples/blink.ts
//
// In your own project the import is:  import { Gpio } from "@liminal-machines-co/gpio";
import { Gpio } from "../src/index.js";

async function main() {
	const bcm = Number(process.argv[2] ?? process.env.GPIO_PIN ?? 17);

	const gpio = new Gpio();
	await gpio.init(); // optional: fail fast if the chip cannot be opened
	const led = gpio.pin(bcm);
	await led.setOutput({ initialValue: false });

	console.log(`blinking BCM ${bcm} — press Ctrl+C to quit`);

	let on = false;
	const interval = setInterval(async () => {
		on = !on;
		await led.write(on);
	}, 500);

	process.on("SIGINT", async () => {
		clearInterval(interval);
		await gpio.release();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
