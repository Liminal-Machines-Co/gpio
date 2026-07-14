# Examples

Runnable examples plus a quick tour of the API.

| File | What it shows |
| --- | --- |
| [`list-chips.ts`](list-chips.ts) | Enumerate available GPIO chips |
| [`blink.ts`](blink.ts) | Configure an output pin and blink it on an interval |
| [`button.ts`](button.ts) | Configure an input with pull-up + edge callback and log presses |
| [`read-write-loop.ts`](read-write-loop.ts) | Poll an input every 100ms and mirror it to an output |
| [`mock.ts`](mock.ts) | Test control logic against `MockGpio` with zero hardware |

## Running them

The examples are TypeScript, run directly with [Bun](https://bun.sh) or
[tsx](https://github.com/privatenumber/tsx) (no build step for the examples
themselves — only the native addon needs building). `blink.ts`, `button.ts`,
and `read-write-loop.ts` need real hardware (a Raspberry Pi); `list-chips.ts`
and `mock.ts` run anywhere:

```sh
npm install
npm run build:native       # build the native addon -> prebuilds/
bun examples/mock.ts
bun examples/list-chips.ts
# on a Pi:
bun examples/blink.ts 17
bun examples/button.ts 27
bun examples/read-write-loop.ts 17 27
# or, without Bun:
npx tsx examples/mock.ts
```

The examples import from `../src`; in your own project you would instead
`import ... from "@liminal-machines-co/gpio"`.

---

## API tour

### Install

```sh
npm install @liminal-machines-co/gpio
```

### List chips

```js
import { Gpio } from "@liminal-machines-co/gpio";

const chips = await Gpio.listChips(); // [{ path, name, label, lines }, ...]
```

### Open the header and get a pin

`new Gpio()` auto-detects the 40-pin header chip (Pi 3/4/5). Pins are
addressed by BCM number and cached — calling `gpio.pin(n)` twice returns the
same instance:

```js
const gpio = new Gpio(); // or new Gpio({ chip: "gpiochip0" }) to override
const pin = gpio.pin(17);
```

### Configure as output or input

```js
await pin.setOutput({ initialValue: false }); // openDrain?, openSource?, activeLow? also available
await pin.setInput({ pullup: true });          // pulldown?, activeLow? also available
```

### Read and write

Both are async — a native GPIO_V2 ioctl round-trip resolved as a Promise:

```js
await pin.write(true);
const value = await pin.read(); // boolean
```

### Edge callbacks

Configure `edge` (and optionally `debounce`, in microseconds) on an input to
receive `onChange(value, timestamp)` on every matching transition. The
timestamp is a kernel-supplied `bigint` (nanoseconds):

```js
await pin.setInput({
  edge: "both", // "rising" | "falling" | "both"
  debounce: 5000,
  onChange: (value, timestamp) => console.log(value, timestamp),
});
```

### Release

```js
await pin.release();  // release one line
await gpio.release();  // release all lines, stop the event thread, close the chip
```

### Test without hardware

`MockGpio` is a drop-in for `Gpio` (same `IGpio`/`IPin` interface) that needs
no device — handy for unit tests. Its `Pin`s add test-only `driveInput()` and
`getOutput()`:

```js
import { MockGpio } from "@liminal-machines-co/gpio";

const gpio = new MockGpio();
const pin = gpio.pin(17);
await pin.setInput({ edge: "both", onChange: (v) => console.log(v) });
pin.driveInput(true); // fires onChange(true, ...)

const out = gpio.pin(27);
await out.setOutput();
await out.write(true);
out.getOutput(); // true
```
