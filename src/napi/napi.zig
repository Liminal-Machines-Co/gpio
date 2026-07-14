//! Ergonomic wrappers over the raw N-API `c` bindings.
//!
//! These collapse the repeated boilerplate (status-discarding calls,
//! NAPI_AUTO_LENGTH string creation, property-descriptor literals,
//! cb_info reading, wrap/unwrap, promise create/resolve/reject) shared
//! across root.zig, serial_port_posix.zig, and serial_port_windows.zig.
//! Behavior is intended to be identical to the raw calls they replace.
const c = @import("c");

pub fn getUndefined(env: c.napi_env) c.napi_value {
    var undef: c.napi_value = undefined;
    _ = c.napi_get_undefined(env, &undef);
    return undef;
}

pub fn getNull(env: c.napi_env) c.napi_value {
    var null_val: c.napi_value = undefined;
    _ = c.napi_get_null(env, &null_val);
    return null_val;
}

pub fn createStringUtf8(env: c.napi_env, s: []const u8) c.napi_value {
    var val: c.napi_value = undefined;
    _ = c.napi_create_string_utf8(env, s.ptr, s.len, &val);
    return val;
}

pub fn createError(env: c.napi_env, msg: []const u8) c.napi_value {
    var text: c.napi_value = undefined;
    _ = c.napi_create_string_utf8(env, msg.ptr, msg.len, &text);
    var err: c.napi_value = undefined;
    _ = c.napi_create_error(env, null, text, &err);
    return err;
}

pub fn createBufferCopy(env: c.napi_env, bytes: []const u8) ?c.napi_value {
    var buffer: c.napi_value = undefined;
    if (c.napi_create_buffer_copy(env, bytes.len, bytes.ptr, null, &buffer) != c.napi_ok) return null;
    return buffer;
}

pub fn throwError(env: c.napi_env, msg: [:0]const u8) void {
    _ = c.napi_throw_error(env, null, msg.ptr);
}

// ---------------------------------------------------------------------------
// Class / method definition
// ---------------------------------------------------------------------------

pub const Method = struct {
    name: [:0]const u8,
    cb: c.napi_callback,
};

pub fn method(name: [:0]const u8, cb: c.napi_callback) c.napi_property_descriptor {
    return .{
        .utf8name = name.ptr,
        .name = null,
        .method = cb,
        .getter = null,
        .setter = null,
        .value = null,
        .attributes = c.napi_default,
        .data = null,
    };
}

/// Defines a class named `name` with constructor `ctor` and the given methods.
pub fn defineClass(env: c.napi_env, name: [:0]const u8, ctor: c.napi_callback, methods: []const Method) c.napi_value {
    var props: [16]c.napi_property_descriptor = undefined;
    for (methods, 0..) |m, i| props[i] = method(m.name, m.cb);

    var class: c.napi_value = undefined;
    _ = c.napi_define_class(
        env,
        name.ptr,
        c.NAPI_AUTO_LENGTH,
        ctor,
        null,
        methods.len,
        &props,
        &class,
    );
    return class;
}

// ---------------------------------------------------------------------------
// Callback info
// ---------------------------------------------------------------------------

pub fn CbInfoResult(comptime argc: usize) type {
    return struct {
        this: c.napi_value,
        argv: [argc]c.napi_value,
    };
}

/// Reads `this` and up to `argc` arguments from callback info.
pub fn cbInfo(env: c.napi_env, info: c.napi_callback_info, comptime argc: usize) !CbInfoResult(argc) {
    var result: CbInfoResult(argc) = undefined;
    var n: usize = argc;
    const argv_ptr: [*c]c.napi_value = if (argc == 0) null else @ptrCast(&result.argv);
    if (c.napi_get_cb_info(env, info, &n, argv_ptr, &result.this, null) != c.napi_ok) {
        throwError(env, "failed to read arguments");
        return error.CbInfo;
    }
    return result;
}

// ---------------------------------------------------------------------------
// wrap / unwrap
// ---------------------------------------------------------------------------

pub fn wrap(env: c.napi_env, this: c.napi_value, ptr: *anyopaque, finalize: c.napi_finalize) void {
    _ = c.napi_wrap(env, this, ptr, finalize, null, null);
}

pub fn unwrap(env: c.napi_env, this: c.napi_value, comptime T: type) ?*T {
    var data: ?*anyopaque = null;
    if (c.napi_unwrap(env, this, &data) != c.napi_ok) return null;
    return @ptrCast(@alignCast(data orelse return null));
}

// ---------------------------------------------------------------------------
// Promises
// ---------------------------------------------------------------------------

pub const Promise = struct {
    deferred: c.napi_deferred,
    promise: c.napi_value,
};

pub fn createPromise(env: c.napi_env) Promise {
    var deferred: c.napi_deferred = undefined;
    var promise: c.napi_value = undefined;
    _ = c.napi_create_promise(env, &deferred, &promise);
    return .{ .deferred = deferred, .promise = promise };
}

pub fn resolve(env: c.napi_env, deferred: c.napi_deferred, value: c.napi_value) void {
    _ = c.napi_resolve_deferred(env, deferred, value);
}

pub fn reject(env: c.napi_env, deferred: c.napi_deferred, err: c.napi_value) void {
    _ = c.napi_reject_deferred(env, deferred, err);
}

/// Convenience: creates a promise and immediately rejects it with `msg`.
pub fn rejectNow(env: c.napi_env, msg: []const u8) c.napi_value {
    const p = createPromise(env);
    reject(env, p.deferred, createError(env, msg));
    return p.promise;
}

// ---------------------------------------------------------------------------
// Object property readers (return null if missing/undefined)
// ---------------------------------------------------------------------------

fn getNamedProperty(env: c.napi_env, obj: c.napi_value, name: [:0]const u8) ?c.napi_value {
    var val: c.napi_value = undefined;
    if (c.napi_get_named_property(env, obj, name.ptr, &val) != c.napi_ok) return null;
    var value_type: c.napi_valuetype = undefined;
    if (c.napi_typeof(env, val, &value_type) != c.napi_ok) return null;
    if (value_type == c.napi_undefined or value_type == c.napi_null) return null;
    return val;
}

pub fn getNamedU32(env: c.napi_env, obj: c.napi_value, name: [:0]const u8) ?u32 {
    const val = getNamedProperty(env, obj, name) orelse return null;
    var out: u32 = undefined;
    if (c.napi_get_value_uint32(env, val, &out) != c.napi_ok) return null;
    return out;
}

pub fn getNamedF64(env: c.napi_env, obj: c.napi_value, name: [:0]const u8) ?f64 {
    const val = getNamedProperty(env, obj, name) orelse return null;
    var out: f64 = undefined;
    if (c.napi_get_value_double(env, val, &out) != c.napi_ok) return null;
    return out;
}

pub fn getNamedBool(env: c.napi_env, obj: c.napi_value, name: [:0]const u8) ?bool {
    const val = getNamedProperty(env, obj, name) orelse return null;
    var out: bool = undefined;
    if (c.napi_get_value_bool(env, val, &out) != c.napi_ok) return null;
    return out;
}

pub fn getNamedStringUtf8(env: c.napi_env, obj: c.napi_value, name: [:0]const u8, buf: []u8) ?[]const u8 {
    const val = getNamedProperty(env, obj, name) orelse return null;
    var len: usize = undefined;
    if (c.napi_get_value_string_utf8(env, val, buf.ptr, buf.len, &len) != c.napi_ok) return null;
    return buf[0..len];
}

// ---------------------------------------------------------------------------
// Value creation
// ---------------------------------------------------------------------------

pub fn createBool(env: c.napi_env, value: bool) c.napi_value {
    var val: c.napi_value = undefined;
    _ = c.napi_get_boolean(env, value, &val);
    return val;
}

pub fn getBool(env: c.napi_env, val: c.napi_value) ?bool {
    var out: bool = undefined;
    if (c.napi_get_value_bool(env, val, &out) != c.napi_ok) return null;
    return out;
}

pub fn createBigInt(env: c.napi_env, value: u64) c.napi_value {
    var val: c.napi_value = undefined;
    _ = c.napi_create_bigint_uint64(env, value, &val);
    return val;
}

pub fn createDouble(env: c.napi_env, value: f64) c.napi_value {
    var val: c.napi_value = undefined;
    _ = c.napi_create_double(env, value, &val);
    return val;
}

pub fn createU32(env: c.napi_env, value: u32) c.napi_value {
    var val: c.napi_value = undefined;
    _ = c.napi_create_uint32(env, value, &val);
    return val;
}

pub fn createObject(env: c.napi_env) c.napi_value {
    var val: c.napi_value = undefined;
    _ = c.napi_create_object(env, &val);
    return val;
}

pub fn setNamed(env: c.napi_env, obj: c.napi_value, name: [:0]const u8, value: c.napi_value) void {
    _ = c.napi_set_named_property(env, obj, name.ptr, value);
}
