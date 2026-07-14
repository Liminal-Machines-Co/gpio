"use strict";

// Native addon loader. `node-gyp-build` selects the correct prebuilt binary
// from ./prebuilds/<platform>-<arch>/ (produced by `zig build`), so consumers
// never need a compiler installed. See build.zig for how prebuilds are laid out.
module.exports = require("node-gyp-build")(__dirname);
