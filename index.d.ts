// Type declarations for the native addon loaded via index.js (node-gyp-build).
// The implementation lives in the Zig sources under src/napi/ and is compiled
// to prebuilds/<platform>-<arch>/gpio.node.

import type { ChipInfo, INativeGpioClass } from "./src/types.js";

export declare const NativeGpio: INativeGpioClass;
export declare function listChips(): ChipInfo[];
