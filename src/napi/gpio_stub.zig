//! Non-Linux stub for NativeGpio.
//!
//! The GPIO uAPI v2 character device is Linux-only. On other platforms the
//! class is still exposed so `require()` succeeds and the shape matches the
//! Linux build; every method throws. Consumers on macOS/Windows use `MockGpio`
//! instead.
const c = @import("c");
const napi = @import("napi.zig");

pub fn defineClass(env: c.napi_env) c.napi_value {
    return napi.defineClass(env, "NativeGpio", construct, &.{
        .{ .name = "open", .cb = notImplemented },
        .{ .name = "requestLine", .cb = notImplemented },
        .{ .name = "setConfig", .cb = notImplemented },
        .{ .name = "readLine", .cb = notImplemented },
        .{ .name = "writeLine", .cb = notImplemented },
        .{ .name = "releaseLine", .cb = notImplemented },
        .{ .name = "close", .cb = notImplemented },
    });
}

fn construct(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;
    return napi.getUndefined(env);
}

fn notImplemented(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;
    napi.throwError(env, "@liminal-machines-co/gpio: GPIO is only supported on Linux");
    return napi.getUndefined(env);
}
