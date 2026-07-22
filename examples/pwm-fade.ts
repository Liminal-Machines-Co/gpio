// Fade an LED up and down using hardware PWM.
//
//   bun examples/pwm-fade.ts 18
//   GPIO_PIN=18 bun examples/pwm-fade.ts
//
// Requires hardware PWM enabled: add `dtoverlay=pwm-2chan` to
// /boot/firmware/config.txt (older Pi OS: /boot/config.txt) and reboot. The
// PWM pins are BCM 12, 13, 18, 19.
//
// In your own project the import is:  import { Gpio } from "@liminal-machines-co/gpio";
import { Gpio } from "../src/index.js";

async function main() {
	const bcm = Number(process.argv[2] ?? process.env.GPIO_PIN ?? 18);

	const gpio = new Gpio();
	await gpio.init(); // warns if PWM isn't set up (permissions / overlay)

	const led = await gpio.pin(bcm).pwm({ frequency: 1000, dutyCycle: 0 });
	console.log(`fading BCM ${bcm} — press Ctrl+C to quit`);

	let level = 0;
	let rising = true;
	const interval = setInterval(async () => {
		level += rising ? 0.05 : -0.05;
		if (level >= 1) {
			level = 1;
			rising = false;
		} else if (level <= 0) {
			level = 0;
			rising = true;
		}
		await led.write(level);
	}, 50);

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
