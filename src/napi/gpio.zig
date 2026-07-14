//! OS dispatcher for the NativeGpio class.
//!
//! Linux has the full uAPI v2 character-device implementation. Other
//! platforms (macOS/Windows) get a throw-stub so `require()` succeeds and
//! `MockGpio` remains usable everywhere. Zig's lazy analysis means only the
//! selected implementation is compiled.
const builtin = @import("builtin");

const impl = if (builtin.os.tag == .linux)
    @import("gpio_linux.zig")
else
    @import("gpio_stub.zig");

pub const defineClass = impl.defineClass;
