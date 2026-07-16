# @liminal-machines-co/gpio

Fast Raspberry Pi GPIO for Node.js. Zig native core → kernel GPIO char device (uAPI v2). No sysfs, no mmap regs. Pi 3/4/5 (RP1). Prebuilt binaries bundled — no build step.

## Import

```ts
import { Gpio, MockGpio } from "@liminal-machines-co/gpio";
```

## Quick usage

```ts
const gpio = new Gpio(); // auto-detects 40-pin header chip (Pi 3/4/5)

const input = gpio.pin(17);
const output = gpio.pin(27);

await input.setInput();
await output.setOutput({ initialValue: false });

setInterval(async () => {
	const value = await input.read();
	await output.write(value);
}, 100);
```

## Gpio API

- `new Gpio(options?)` — opens header chip. `{ chip: "gpiochip0" }` overrides auto-detect.
- `gpio.init()` — optional. Opens chip now → missing device / bad perms fail at startup. Else chip opens lazily on first pin config, error surfaces there.
- `gpio.pin(bcm)` — stable cached `Pin` for BCM number.
- `gpio.release()` — release all lines, stop event thread, close chip.
- `Gpio.listChips()` — static. Lists every `/dev/gpiochipN` + label + line count.

## Pin API

- `pin.setInput(options?)` / `pin.setOutput(options?)` — configure line. Call again on requested pin → reconfigures in place.
- `pin.read()` / `pin.write(value)` — async, return Promise. `value` always `boolean`.
- `pin.release()` — release one line.

Input options: `pullup`, `pulldown`, `openDrain`, `openSource`, `activeLow`, `edge`, `debounce`, `onChange`.
Output options: `initialValue`, `activeLow`, `openDrain`, `openSource`.

## Edge callbacks

Set `edge` (+ optional `debounce`, microseconds) on input → `onChange(value, timestamp)` on each matching transition. `timestamp` = kernel `bigint` nanoseconds.

```ts
await gpio.pin(27).setInput({
	pullup: true,
	edge: "both", // "rising" | "falling" | "both"
	debounce: 5000,
	onChange: (value, timestamp) => console.log(value, timestamp),
});
```

All lines' edges → single background poll thread (no thread per pin).

## Mock (no hardware)

`MockGpio` = drop-in for `Gpio`, same interface. Pins add test-only `driveInput()` / `getOutput()`.

```ts
const gpio = new MockGpio();
const pin = gpio.pin(17);
await pin.setInput({ edge: "both", onChange: (v) => console.log(v) });
pin.driveInput(true); // fires onChange(true, ...)

const out = gpio.pin(27);
await out.setOutput();
await out.write(true);
out.getOutput(); // true
```

## Gotchas

- **Linux-only.** Real `Gpio` throws `"GPIO is only supported on Linux"` on macOS/Windows. `import` + `MockGpio` work everywhere for dev/test.
- **Unbounded write backlog.** `read`/`write` are async. Unawaited calls issued faster than they complete pile up pending work without bound → memory blowup. In sustained loops (timer toggle) `await` or `.catch`.
- **Edge storm drops events.** Delivery bounded: if edges arrive faster than JS drains (bouncy/floating input), excess dropped, not queued. Set `debounce` to tame.
- **v1 scope = digital r/w + bias (pullup/pulldown/open-drain) + edges only.** PWM/I2C/SPI NOT implemented (separate kernel subsystems, planned as own classes).
- **CLI stubbed.** `liminal-gpio` (`info`/`read`/`write`) prints intended behavior, does not touch hardware yet. Use library API.
