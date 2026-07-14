# CLAUDE.md

Guidance for working in this repository.

## What this is

`@liminal-machines-co/gpio` — a small Raspberry Pi GPIO library for Node.js with a **Zig**-backed
native core, talking to the kernel GPIO character device (**uAPI v2** — no sysfs, no
memory-mapped registers). Works across Pi 3, 4, and 5 (RP1). The design goal is effortless
multi-platform distribution: Zig cross-compiles every target from one machine, and Node-API
symbols resolve at load time, so prebuilt binaries for all platforms are built in a single CI job
and bundled into the published package. Consumers need no compiler, no node-gyp, and no install
scripts.

## Stack

- **Native core:** Zig `0.16.0` (pinned).
  - N-API: raw C API via `@import("c")`, a `translateC` of
    [`node-api-headers`](https://github.com/nodejs/node-api-headers). No zig-napi
    dependency (see decisions).
  - GPIO uAPI v2 structs/ioctls are hand-declared in Zig — no `linux/gpio.h` translateC step, and
    it keeps the macOS host build clean (the stub side never needs the real structs).
- **JS/TS layer:** TypeScript `5.7`, compiled with `tsc` (module `NodeNext`,
  package `"type": "commonjs"`). Node `>= 18`.
- **Loader:** `node-gyp-build` selects `prebuilds/<platform>-<arch>/gpio.node`.
- **Tests:** [Bun](https://bun.sh) test runner (runs `.ts` directly).
- **Lint/format:** Biome (run via `bunx --bun @biomejs/biome`). Tabs, not spaces.
- **CI/release:** GitHub Actions; `npm version` + tag-triggered publish.

## Layout

```
src/
  napi/                 Zig native addon
    root.zig            napi_register_module_v1: defines class + listChips
    napi.zig            ergonomic wrappers over the raw `c` N-API bindings
    gpio.zig             OS dispatcher (linux impl vs non-linux stub)
    gpio_linux.zig       NativeGpio: uAPI v2 ioctls, poll thread + TSFN for edges,
                         async-work Promises for read/write
    gpio_stub.zig        stub: loads + throws "GPIO is only supported on Linux"
    enumerate.zig        listChips() + detectHeaderChip() — scans /dev/gpiochip*
  Gpio.ts                public controller: opens the chip, caches Pin instances
  Pin.ts                 per-line wrapper: setInput/setOutput/read/write/release
  mock/MockGpio.ts        standalone IGpio/IPin for hardware-free tests
  native.ts              memoized loader for the native binding (getNative)
  options.ts             validateGpioOptions / validatePinInputOptions / validatePinOutputOptions
  types.ts               interfaces (IGpio, IPin, NativeLineConfig, INativeGpio, …)
  cli.ts                 `liminal-gpio` CLI (bin) — info/read/write are v1 stubs
  index.ts               public barrel
index.js / index.d.ts    root native loader (node-gyp-build) + its types
build.zig / build.zig.zon  native build + deps
prebuilds/              built .node binaries (gitignored; produced by build)
test/                   integration + hardware suites + helpers
examples/               runnable .ts usage examples
```

## Architecture decisions

1. **Zig native, not Rust/C++.** Zig cross-compiles all targets from a single
   host with no per-platform toolchain. N-API symbols are undefined until load
   (`-fallow-shlib-undefined`), so the addon never links libnode.

2. **Raw N-API translate-c, not zig-napi.** The zig-napi wrapper lacks
   `napi_wrap`/`define_class`/threadsafe-functions/async-work/promises/buffers
   and discarded `this`. We `translateC` `node-api-headers` directly and keep
   ergonomic helpers in `napi.zig`. This also drops a dependency keeping the dependency tree
   lean.

3. **GPIO uAPI v2 char device, not sysfs.** `/dev/gpiochipN` ioctls
   (`GPIO_V2_GET_LINE_IOCTL`, `GPIO_V2_LINE_SET_CONFIG_IOCTL`,
   `GPIO_V2_LINE_GET_VALUES_IOCTL`/`SET_VALUES_IOCTL`) put the kernel in charge of
   muxing/pull/debounce/timestamps and are portable across Pi 3/4/5 without touching
   memory-mapped registers.

4. **Threading model.** One background poll thread per `Gpio`, spawned lazily on the
   first edge-enabled line, multiplexes every requested line's edge fd plus a self-pipe
   wake and reaches the JS callback via a single **threadsafe function** tagged with the
   pin offset. `readLine`/`writeLine` use `napi_create_async_work` (libuv threadpool) and
   resolve a Promise. Directly adapted from the prior serial read-thread/TSFN pattern.

5. **Linux-only; stub elsewhere.** `gpio.zig` dispatches to `gpio_linux.zig` on Linux and
   `gpio_stub.zig` everywhere else — the class loads and every method throws
   `"GPIO is only supported on Linux"`. Lets macOS/Windows consumers `require` the
   package and use `MockGpio`; the real `Gpio` throws.

6. **BCM numbering, auto-detected header chip.** `new Gpio()` scans `/dev/gpiochip*`,
   reads each chip's label via `GPIO_GET_CHIPINFO_IOCTL`, and picks the one matching
   `pinctrl-bcm2835` (Pi 3) / `pinctrl-bcm2711` (Pi 4) / `pinctrl-rp1` (Pi 5). An explicit
   `{ chip }` option overrides detection.

7. **Mock is a standalone `IGpio`/`IPin`, not a native dependency.** `MockGpio`/`MockPin`
   replace `Gpio`/`Pin` wholesale for tests; they do not ride the native binding, and add
   test-only `driveInput()`/`getOutput()`.

8. **Native binding loaded lazily, once.** `native.ts#getNative()` memoizes a
   single dynamic `import("../index.js")`, unwraps the CJS `.default`, and
   remaps "Cannot find native binding" to a friendly per-platform message.
   Loading is deferred so importing the barrel (for MockGpio) never touches
   the native binary.

9. **PWM/I2C/SPI are throw-stubs, not implemented.** They're separate kernel subsystems
   (`/sys/class/pwm`, `/dev/i2c-N`, `/dev/spidev`) planned as their own top-level classes
   in a future release, not members of `Gpio`. v1 scope is digital read/write + pull/bias
   + edge callbacks only.

## Native contract (must stay in sync across tiers)

`index.d.ts` and `src/types.ts` (`NativeLineConfig`, `INativeGpio`) declare the native
surface; `src/Pin.ts`/`src/Gpio.ts` call it; `gpio_linux.zig` implements it. Any change to
a line config object must match the property names read by the Zig `getNamed*` calls:
`direction, pullup, pulldown, openDrain, openSource, activeLow, edge, debounce, initialValue`.

## Build & dev setup

Requires Zig `0.16.0` and Node `>= 18`. Bun for tests/lint.

```sh
npm install
npm run build:native      # build addon for the host -> prebuilds/
npm run build:prebuilds   # cross-compile every target (macOS/Linux/Windows)
npm run build:ts          # tsc -> dist/
npm run build             # native + ts
```

`build:native` runs `zig build --prefix . -Doptimize=ReleaseFast`; `--prefix .`
puts the output under `./prebuilds`. Debug builds: `-Doptimize=Debug`.

## Testing

Three suites on the Bun runner (Bun executes `.ts` directly — no precompile):

```sh
npm test                # unit: mock + options (src/**/*.test.ts), hermetic
npm run test:integration  # native addon over a gpio-sim virtual chip (Linux + root)
npm run test:hardware     # real Pi, opt-in (see below)
npm run typecheck         # tsc --noEmit (source)
npm run typecheck:test    # tsc -p tsconfig.test.json (source + tests)
```

- Integration uses the kernel's **`gpio-sim`** (configfs) to create a virtual gpiochip; it
  needs Linux, root, and the module loaded, and self-skips otherwise (mirrors the old
  serial socat self-skip pattern). See `test/helpers/gpio-sim.ts#gpioSimAvailable()`.
- **Hardware suite is opt-in** and gated on `GPIO_TEST_CHIP`; it never runs in
  CI or by accident:
  ```sh
  GPIO_TEST_CHIP=/dev/gpiochip0 npm run test:hardware
  ```
  It exercises a wired loopback (output pin jumpered to an input pin) through the public
  `Gpio`/`Pin` API, including an edge `onChange` assertion.

## Release process

Tag-driven. See `RELEASING.md`.

```sh
npm version patch|minor|major
```

- `preversion` gate: `lint && typecheck && test` (unit).
- `npm version` bumps `package.json`, commits, tags `vX.Y.Z`.
- `postversion`: `git push --follow-tags`.
- The tag triggers the `publish` CI job: it waits for `test` + `prebuilds`,
  verifies the tag matches `package.json` and that all five prebuilds exist,
  then `npm publish --provenance --access public`.

CI is authenticated to npm via trusted publishing.

## CI (`.github/workflows/ci.yml`)

- `test` — Node + Bun + Zig; typecheck, unit, integration (Linux runner with `gpio-sim`).
- `prebuilds` — one runner cross-compiles all targets, uploads the artifact.
- `publish` — tag-gated; downloads prebuilds, verifies, publishes.

## Conventions

- Biome formats with **tabs**; run `npm run lint:fix` before committing. The
  `preversion` gate runs `lint` and fails on Biome errors (warnings are OK).
- Commit/push only when asked.
- Keep the `NativeLineConfig` property names identical across `types.ts`,
  `Pin.ts`/`Gpio.ts`, and `gpio_linux.zig`.
- Examples are `.ts` run via bun/tsx; wrap logic in `async main()` (top-level
  await is illegal under the CJS output tsx produces).

## Gotchas

- Zig 0.16 `std.posix` dropped `write`/`close`/`pipe`/`ioctl` — the Linux impl declares
  its own `extern "c"` for those (and `read`/`poll`).
- Zig 0.16 removed `std.Thread.Mutex` from where earlier code expected it in some
  configurations — if a build breaks on that symbol, reach for a small hand-rolled
  spinlock over the shared line/poll-set state rather than assuming the old API shape.
- `tsc` disallows top-level `await` and `import.meta` in CommonJS output; use
  `__dirname`/`main()` in TS that must pass `typecheck:test`.
- `@types/bun` + `@types/node` skew is handled by `skipLibCheck: true`.
