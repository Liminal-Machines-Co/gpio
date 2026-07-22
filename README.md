![cover](assets/cover.jpg)

# @liminal-machines-co/gpio

A small, fast Raspberry Pi GPIO library for Node.js with a **Zig**-backed
native core, talking to the kernel GPIO character device (**uAPI v2**) —
no sysfs, no memory-mapped registers. Works on Pi 3, 4, and 5 (RP1). Prebuilt
native binaries for all platforms are bundled into the package, so you
probably can just install and go without any build process after install.

## Install

```sh
npm install @liminal-machines-co/gpio
```

## Usage

```ts
import { Gpio } from "@liminal-machines-co/gpio";

const gpio = new Gpio(); // auto-detects the 40-pin header chip (Pi 3/4/5)

const input = gpio.pin(17);
const output = gpio.pin(27);

await input.setInput();
await output.setOutput({ initialValue: false });

// Read an input every 100ms and mirror it to an output.
setInterval(async () => {
	const value = await input.read();
	await output.write(value);
}, 100);
```

See [`examples/`](examples/) for runnable scripts, including a button with an
edge callback and an LED blink.

### The `Gpio` / `Pin` API

- `new Gpio(options?)` — opens the header chip. Pass `{ chip: "gpiochip0" }`
  to override auto-detection.
- `gpio.init()` — optional; opens the chip immediately so a missing device or
  insufficient permissions fail at startup. Without it, the chip is opened
  lazily on the first pin configuration and any open error surfaces there.
- `gpio.pin(bcm)` — returns a stable, cached `Pin` for a BCM pin number.
- `pin.setInput(options?)` / `pin.setOutput(options?)` — configure the line.
  Calling either again on an already-requested pin reconfigures it in place.
- `pin.read()` / `pin.write(value)` — async; `value` is always a `boolean`.
  Both return a Promise: in sustained loops (e.g. toggling on a timer), `await`
  it or attach `.catch` — unawaited calls issued faster than they complete
  accumulate pending work without bound.
- `pin.pwm(config?)` — switch the pin to **hardware PWM** and return a
  `PwmChannel` (see below). Only BCM 12/13/18/19.
- `pin.release()` — release that one line (or PWM channel).
- `gpio.release()` — release all lines, unexport all PWM channels, stop the
  event thread, close the chip.
- `Gpio.listChips()` — static, lists every `/dev/gpiochipN` with its label and
  line count.

### Edge callbacks

Configure `edge` (and optionally `debounce`, in microseconds) on an input to
get `onChange(value, timestamp)` on every matching transition. `timestamp` is
a kernel-supplied `bigint` (nanoseconds):

```ts
await gpio.pin(27).setInput({
	pullup: true,
	edge: "both", // "rising" | "falling" | "both"
	debounce: 5000,
	onChange: (value, timestamp) => console.log(value, timestamp),
});
```

Edges for every configured line on a `Gpio` are delivered through a single
background poll thread — no extra threads per pin. Delivery is bounded: if
events arrive faster than the JS thread drains them (an edge storm on a bouncy
or floating input), excess events are dropped rather than queued without limit
— set `debounce` to tame such inputs.

### Hardware PWM

`pin.pwm(config?)` switches a pin into hardware-PWM mode and returns a
`PwmChannel`. It's a mode of the pin — a pin is digital **or** PWM, never both,
so `setOutput()` and `pwm()` on the same pin can't collide:

```ts
const led = await gpio.pin(18).pwm({ frequency: 1000, dutyCycle: 0.5 });
await led.write(0.25); // duty cycle as a 0..1 ratio
await led.setFrequency(2000); // duty ratio is preserved
await led.disable(); // stop output, stay exported
await led.release(); // unexport, return the pin to unconfigured
```

- **Only BCM 12, 13, 18, 19** are hardware-PWM pins. 12 & 18 share channel 0;
  13 & 19 share channel 1 — you can't drive both pins of a channel at once.
- `PwmChannel`: `write(ratio)` / `setDutyCycle(ratio)`, `setFrequency(hz)`,
  `setPolarity("normal" | "inversed")`, `disable()`, `release()`.
- `config`: `{ frequency? (Hz) | period? (ns), dutyCycle? (0..1), polarity?,
  enabled? }` — set `frequency` **or** `period`, not both.

**Setup.** Hardware PWM needs the device-tree overlay enabled: add
`dtoverlay=pwm-2chan` to `/boot/firmware/config.txt` (older Pi OS:
`/boot/config.txt`) and reboot. sysfs PWM is also root-only unless your user is
in the `gpio` group:

```sh
sudo usermod -aG gpio $(whoami)   # then log out and back in
```

`gpio.init()` checks this and prints a copy-pasteable hint (it warns, never
throws — GPIO-only apps are unaffected). Pi 5 (RP1) channel muxing varies; pass
`new Gpio({ pwmChip: "pwmchip0" })` to pick the chip explicitly.

### Testing without hardware

`MockGpio` is a drop-in for `Gpio` (same interface), so you can test your GPIO
logic with no device attached. Its `Pin`s add test-only `driveInput()` and
`getOutput()`:

```ts
import { MockGpio } from "@liminal-machines-co/gpio";

const gpio = new MockGpio();
const pin = gpio.pin(17);
await pin.setInput({ edge: "both", onChange: (v) => console.log(v) });
pin.driveInput(true); // fires onChange(true, ...)

const out = gpio.pin(27);
await out.setOutput();
await out.write(true);
out.getOutput(); // true

const led = await gpio.pin(18).pwm({ frequency: 1000 });
await led.write(0.5);
led.getDutyCycle(); // 0.5 — MockPwmChannel adds getFrequency/getDutyCycle/isEnabled/getPolarity
```

## Platform support

GPIO is a **Linux-only** feature — Raspberry Pi OS and other Linux
distributions. On macOS/Windows, `require`/`import` still works so you can
develop and test against `MockGpio`, but the real `Gpio` throws `"GPIO is only
supported on Linux"` when opened.

| Platform           | `MockGpio` | Real `Gpio` (Pi 3/4/5) |
| ------------------ | ---------- | ----------------------- |
| Linux (arm64, x64)  | ✅         | ✅                       |
| macOS (arm64, x64)  | ✅         | ❌ (throws)              |
| Windows (x64)       | ✅         | ❌ (throws)              |

### Scope

v1 covers digital read/write, pull-up/pull-down/open-drain bias, edge
callbacks, and hardware **PWM** (`pin.pwm()`, see above). **I2C and SPI** are
separate kernel subsystems (`/dev/i2c-N`, `/dev/spidev`) and are **not
implemented** in this release — they're planned as their own top-level classes,
not members of `Gpio`.

The `liminal-gpio` CLI (`info` / `read` / `write`) is also stubbed in v1: it
prints the intended behavior of each command but does not touch hardware yet.
Use the library API directly for now.

## Contributing

You'll need [Zig 0.16.0](https://ziglang.org/download/) and Node ≥ 18.

```sh
npm install
npm run build:native      # build the addon for your host -> prebuilds/
npm run build:prebuilds   # cross-compile every target
```

Releases go out via `npm version` + a git tag — see [RELEASING.md](RELEASING.md).
Architecture, decisions, and conventions live in [CLAUDE.md](CLAUDE.md).

### Tests

Tests run on the [Bun](https://bun.sh) runner in three suites:

```sh
npm test                 # unit: mock + options, pure JS, no hardware
npm run test:integration # native addon over a gpio-sim virtual chip (Linux + root)
npm run test:hardware    # against a real Pi (opt-in, see below)
npm run typecheck:test   # type-check the test sources
```

- **Unit** (`src/**/*.test.ts`) — `MockGpio`/`MockPin` and option validation.
- **Integration** (`test/integration/`) — drives the real native binding
  through a virtual gpiochip created with the kernel's `gpio-sim` (configfs).
  Requires Linux, root, and the `gpio-sim` module; self-skips otherwise (e.g.
  on macOS, or Linux CI without the module).
- **Hardware** (`test/hardware/`) — an opt-in suite for a real Raspberry Pi
  with a wired loopback (an output pin jumpered to an input pin):

  ```sh
  GPIO_TEST_CHIP=/dev/gpiochip0 npm run test:hardware
  ```

  With `GPIO_TEST_CHIP` unset it skips, so it never runs in CI or by accident.

### Overview

- `src/napi/*.zig` — the native addon. `root.zig` registers the module and
  `listChips()`; `gpio_linux.zig` implements `NativeGpio` (uAPI v2 ioctls,
  a single poll thread + threadsafe function for edges, async-work Promises
  for read/write); `gpio_stub.zig` is the non-Linux throw-stub;
  `enumerate.zig` scans `/dev/gpiochip*` and auto-detects the header chip.
- `src/*.ts` — the JS layer: `Gpio`, `Pin`, `MockGpio`/`MockPin`, and option
  validation.
- `index.js` — loads the right prebuilt `.node` via `node-gyp-build`.
- N-API headers come from [node-api-headers](https://github.com/nodejs/node-api-headers).

## License

MIT
