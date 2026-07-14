// Test control logic against MockGpio with zero hardware. This is the
// hardware-free path: MockGpio implements the same IGpio/IPin interface as
// the real Gpio/Pin, plus test-only driveInput()/getOutput() to script
// scenarios.
//
//   bun examples/mock.ts
//   npx tsx examples/mock.ts
//
// In your own project the import is:  import { MockGpio } from "@liminal-machines-co/gpio";
import { MockGpio } from "../src/index.js";

async function main() {
	const gpio = new MockGpio();

	// Same API as the real Gpio: configure a pin, then read/write it.
	const output = gpio.pin(27);
	await output.setOutput({ initialValue: false });
	await output.write(true);
	console.log("output value:", output.getOutput()); // true

	// Drive a virtual input and observe the wired onChange callback fire.
	const input = gpio.pin(17);
	await input.setInput({
		edge: "both",
		onChange: (value, timestamp) => {
			console.log(`mock BCM 17 -> ${value} @ ${timestamp}ns`);
		},
	});

	input.driveInput(true); // fires onChange(true, ...)
	input.driveInput(false); // fires onChange(false, ...)

	await gpio.release();
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
