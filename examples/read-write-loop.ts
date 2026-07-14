// Read an input pin every 100ms and mirror its value onto an output pin.
//
//   bun examples/read-write-loop.ts 17 27
//   GPIO_IN=17 GPIO_OUT=27 bun examples/read-write-loop.ts
//
// In your own project the import is:  import { Gpio } from "@liminal-machines-co/gpio";
import { Gpio } from "../src/index.js";

async function main() {
	const inBcm = Number(process.argv[2] ?? process.env.GPIO_IN ?? 17);
	const outBcm = Number(process.argv[3] ?? process.env.GPIO_OUT ?? 27);

	const gpio = new Gpio();
	const input = gpio.pin(inBcm);
	const output = gpio.pin(outBcm);

	await input.setInput();
	await output.setOutput({ initialValue: false });

	console.log(`mirroring BCM ${inBcm} -> BCM ${outBcm} — press Ctrl+C to quit`);

	const interval = setInterval(async () => {
		const value = await input.read();
		await output.write(value);
	}, 100);

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
