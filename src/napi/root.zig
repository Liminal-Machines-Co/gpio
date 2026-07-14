const std = @import("std");
const c = @import("c");
const napi = @import("napi.zig");
const enumerate = @import("enumerate.zig");
const gpio = @import("gpio.zig");

const alloc = std.heap.c_allocator;

/// napi_register_module_v1 is the entry point Node calls when the addon loads.
fn registerModule(env: c.napi_env, exports: c.napi_value) callconv(.c) c.napi_value {
    // NativeGpio class
    const class = gpio.defineClass(env);
    _ = c.napi_set_named_property(env, exports, "NativeGpio", class);

    // listChips()
    var list_chips_fn: c.napi_value = undefined;
    if (c.napi_create_function(env, "listChips", c.NAPI_AUTO_LENGTH, listChips, null, &list_chips_fn) == c.napi_ok) {
        _ = c.napi_set_named_property(env, exports, "listChips", list_chips_fn);
    }

    // detectHeaderChip()
    var detect_fn: c.napi_value = undefined;
    if (c.napi_create_function(env, "detectHeaderChip", c.NAPI_AUTO_LENGTH, detectHeaderChip, null, &detect_fn) == c.napi_ok) {
        _ = c.napi_set_named_property(env, exports, "detectHeaderChip", detect_fn);
    }

    return exports;
}

fn listChips(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;

    var arr: c.napi_value = undefined;
    _ = c.napi_create_array(env, &arr);

    const entries = enumerate.scan(alloc) catch return arr;
    defer enumerate.free(alloc, entries);

    for (entries, 0..) |entry, i| {
        const obj = napi.createObject(env);
        napi.setNamed(env, obj, "path", napi.createStringUtf8(env, entry.path));
        napi.setNamed(env, obj, "name", napi.createStringUtf8(env, entry.name));
        napi.setNamed(env, obj, "label", napi.createStringUtf8(env, entry.label));
        napi.setNamed(env, obj, "lines", napi.createU32(env, entry.lines));
        _ = c.napi_set_element(env, arr, @intCast(i), obj);
    }

    return arr;
}

fn detectHeaderChip(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;

    const path = enumerate.detectHeaderChip(alloc) catch return napi.getNull(env);
    if (path) |p| {
        defer alloc.free(p);
        return napi.createStringUtf8(env, p);
    }
    return napi.getNull(env);
}

comptime {
    @export(&registerModule, .{ .name = "napi_register_module_v1" });
}
