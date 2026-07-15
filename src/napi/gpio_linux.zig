//! Native `NativeGpio` class backing src/Gpio.ts / src/Pin.ts.
//!
//! Contract (see src/types.ts INativeGpio):
//!   open(chipPath, onEvent(offset, value, timestamp))
//!   requestLine(offset, config): void       - GPIO_V2_GET_LINE_IOCTL
//!   setConfig(offset, config): void         - GPIO_V2_LINE_SET_CONFIG_IOCTL
//!   readLine(offset): Promise<boolean>      - GPIO_V2_LINE_GET_VALUES_IOCTL
//!   writeLine(offset, value): Promise<void> - GPIO_V2_LINE_SET_VALUES_IOCTL
//!   releaseLine(offset): void
//!   close(): void
//!
//! Edge events are delivered through a single event thread multiplexing all
//! edge-enabled line fds plus a self-pipe wake, dispatched to JS via one
//! threadsafe function (analogous to the read thread in the former serial
//! backend). readLine/writeLine run on the libuv threadpool via async work
//! and resolve a Promise, also mirroring the serial write/drain pattern.
//! Linux only; see gpio_stub.zig for other platforms.
const std = @import("std");
const c = @import("c");
const napi = @import("napi.zig");
const gpio_ioctl = @import("gpio_ioctl.zig");

const alloc = std.heap.c_allocator;

// libc pieces not exposed as `pub` by std.c.
extern "c" fn read(fd: std.c.fd_t, buf: [*]u8, nbyte: usize) isize;
extern "c" fn write(fd: std.c.fd_t, buf: [*]const u8, nbyte: usize) isize;
extern "c" fn close(fd: std.c.fd_t) c_int;
extern "c" fn pipe(fds: *[2]std.c.fd_t) c_int;
extern "c" fn poll(fds: [*]std.c.pollfd, nfds: std.c.nfds_t, timeout: c_int) c_int;
extern "c" fn ioctl(fd: std.c.fd_t, request: c_ulong, ...) c_int;

const CONSUMER = "liminal-gpio";

const LineEntry = struct {
    fd: std.c.fd_t,
    edge: bool,
};

/// Minimal spinlock. `std.Thread.Mutex` was removed in Zig 0.16 in favor of
/// an `Io`-based `std.Io.Mutex`; we have no `Io` implementation to hand it
/// here, and contention between the JS thread and the single event thread is
/// negligible, so a spinlock is sufficient.
const SpinLock = struct {
    locked: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    fn lock(self: *SpinLock) void {
        while (self.locked.cmpxchgWeak(false, true, .acquire, .monotonic) != null) {
            std.atomic.spinLoopHint();
        }
    }

    fn unlock(self: *SpinLock) void {
        self.locked.store(false, .release);
    }
};

const Gpio = struct {
    chip_fd: std.c.fd_t = -1,
    is_open: bool = false,
    tsfn: c.napi_threadsafe_function = null,
    thread: ?std.Thread = null,
    stop: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    // self-pipe used to interrupt the blocking poll() on close / line changes.
    wake_r: std.c.fd_t = -1,
    wake_w: std.c.fd_t = -1,
    // guards `lines`, which is read by the event thread and mutated by JS-thread methods.
    mutex: SpinLock = .{},
    lines: std.AutoHashMap(u32, LineEntry) = undefined,
};

/// Heap payload handed from the event thread to the JS callback via the TSFN.
const Chunk = struct {
    offset: u32,
    value: bool,
    timestamp_ns: u64,
};

const WorkKind = enum { read, write };

/// State for a queued async readLine/writeLine operation.
const Work = struct {
    kind: WorkKind,
    fd: std.c.fd_t,
    value: bool = false,
    ok: bool = false,
    deferred: c.napi_deferred,
    work: c.napi_async_work = null,
};

// ---------------------------------------------------------------------------
// Class definition
// ---------------------------------------------------------------------------

pub fn defineClass(env: c.napi_env) c.napi_value {
    return napi.defineClass(env, "NativeGpio", construct, &.{
        .{ .name = "open", .cb = jsOpen },
        .{ .name = "requestLine", .cb = jsRequestLine },
        .{ .name = "setConfig", .cb = jsSetConfig },
        .{ .name = "readLine", .cb = jsReadLine },
        .{ .name = "writeLine", .cb = jsWriteLine },
        .{ .name = "releaseLine", .cb = jsReleaseLine },
        .{ .name = "close", .cb = jsClose },
    });
}

fn construct(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    const cb = napi.cbInfo(env, info, 0) catch return napi.getUndefined(env);
    const gpio = alloc.create(Gpio) catch {
        napi.throwError(env, "out of memory");
        return napi.getUndefined(env);
    };
    gpio.* = .{ .lines = std.AutoHashMap(u32, LineEntry).init(alloc) };
    if (!napi.wrap(env, cb.this, gpio, finalize)) {
        gpio.lines.deinit();
        alloc.destroy(gpio);
        napi.throwError(env, "failed to wrap NativeGpio");
        return napi.getUndefined(env);
    }
    return cb.this;
}

fn finalize(_: c.napi_env, data: ?*anyopaque, _: ?*anyopaque) callconv(.c) void {
    const gpio: *Gpio = @ptrCast(@alignCast(data orelse return));
    shutdown(gpio);
    gpio.lines.deinit();
    alloc.destroy(gpio);
}

// ---------------------------------------------------------------------------
// open(chipPath, onEvent)
// ---------------------------------------------------------------------------

fn jsOpen(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    const cb = napi.cbInfo(env, info, 2) catch return napi.getUndefined(env);
    const argv = cb.argv;
    const gpio = napi.unwrap(env, cb.this, Gpio) orelse return napi.getUndefined(env);

    if (gpio.is_open) {
        napi.throwError(env, "Gpio is already open");
        return napi.getUndefined(env);
    }

    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    var path_len: usize = 0;
    if (c.napi_get_value_string_utf8(env, argv[0], &path_buf, path_buf.len, &path_len) != c.napi_ok) {
        napi.throwError(env, "invalid chip path");
        return napi.getUndefined(env);
    }
    path_buf[path_len] = 0;
    const path_z: [*:0]const u8 = @ptrCast(&path_buf);

    const oflag = std.c.O{ .ACCMODE = .RDWR };
    const fd = std.c.open(path_z, oflag, @as(std.c.mode_t, 0));
    if (fd < 0) {
        napi.throwError(env, "failed to open GPIO chip");
        return napi.getUndefined(env);
    }

    var wake_pipe: [2]std.c.fd_t = undefined;
    if (pipe(&wake_pipe) != 0) {
        _ = close(fd);
        napi.throwError(env, "failed to create wake pipe");
        return napi.getUndefined(env);
    }

    const res_name = napi.createStringUtf8(env, "liminalGpioEvent");
    var tsfn: c.napi_threadsafe_function = null;
    if (c.napi_create_threadsafe_function(
        env,
        argv[1], // JS onEvent callback
        null,
        res_name,
        // max_queue_size: bounded so an edge storm cannot grow the queue (and
        // the JS heap behind it) without limit. The event thread enqueues
        // nonblocking; when the queue is full the call fails and the event is
        // dropped (see eventLoop). Use `debounce` for bouncy inputs.
        1024,
        1, // initial_thread_count: held until close(), even before the event thread spawns
        null,
        null,
        gpio,
        callJs,
        &tsfn,
    ) != c.napi_ok) {
        _ = close(fd);
        _ = close(wake_pipe[0]);
        _ = close(wake_pipe[1]);
        napi.throwError(env, "failed to create threadsafe function");
        return napi.getUndefined(env);
    }

    gpio.chip_fd = fd;
    gpio.wake_r = wake_pipe[0];
    gpio.wake_w = wake_pipe[1];
    gpio.tsfn = tsfn;
    gpio.stop.store(false, .seq_cst);
    gpio.is_open = true;

    return napi.getUndefined(env);
}

// ---------------------------------------------------------------------------
// requestLine(offset, config)
// ---------------------------------------------------------------------------

fn jsRequestLine(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    const cb = napi.cbInfo(env, info, 2) catch return napi.getUndefined(env);
    const argv = cb.argv;
    const gpio = napi.unwrap(env, cb.this, Gpio) orelse return napi.getUndefined(env);
    if (!gpio.is_open) {
        napi.throwError(env, "Gpio is not open");
        return napi.getUndefined(env);
    }

    var offset: u32 = undefined;
    if (c.napi_get_value_uint32(env, argv[0], &offset) != c.napi_ok) {
        napi.throwError(env, "invalid offset");
        return napi.getUndefined(env);
    }

    const built = buildLineConfig(env, argv[1]);

    var req: gpio_ioctl.gpio_v2_line_request = std.mem.zeroes(gpio_ioctl.gpio_v2_line_request);
    req.offsets[0] = offset;
    req.num_lines = 1;
    @memcpy(req.consumer[0..CONSUMER.len], CONSUMER);
    req.config = built.config;

    if (ioctl(gpio.chip_fd, gpio_ioctl.GPIO_V2_GET_LINE_IOCTL, &req) < 0) {
        napi.throwError(env, "failed to request GPIO line");
        return napi.getUndefined(env);
    }

    var put_failed = false;
    {
        gpio.mutex.lock();
        defer gpio.mutex.unlock();
        // The kernel normally EBUSYs a second request for the same offset, but
        // if an entry does get replaced its fd must not be leaked.
        if (gpio.lines.fetchRemove(offset)) |old| _ = close(old.value.fd);
        gpio.lines.put(offset, .{ .fd = req.fd, .edge = built.edge }) catch {
            put_failed = true;
        };
    }
    if (put_failed) {
        _ = close(req.fd);
        napi.throwError(env, "out of memory");
        return napi.getUndefined(env);
    }

    if (built.edge) ensureThreadAndWake(env, gpio);

    return napi.getUndefined(env);
}

// ---------------------------------------------------------------------------
// setConfig(offset, config)
// ---------------------------------------------------------------------------

fn jsSetConfig(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    const cb = napi.cbInfo(env, info, 2) catch return napi.getUndefined(env);
    const argv = cb.argv;
    const gpio = napi.unwrap(env, cb.this, Gpio) orelse return napi.getUndefined(env);
    if (!gpio.is_open) {
        napi.throwError(env, "Gpio is not open");
        return napi.getUndefined(env);
    }

    var offset: u32 = undefined;
    if (c.napi_get_value_uint32(env, argv[0], &offset) != c.napi_ok) {
        napi.throwError(env, "invalid offset");
        return napi.getUndefined(env);
    }

    const maybe_fd = blk: {
        gpio.mutex.lock();
        defer gpio.mutex.unlock();
        const entry = gpio.lines.get(offset) orelse break :blk null;
        break :blk entry.fd;
    };
    const line_fd = maybe_fd orelse {
        napi.throwError(env, "line not requested");
        return napi.getUndefined(env);
    };

    const built = buildLineConfig(env, argv[1]);
    var config = built.config;
    if (ioctl(line_fd, gpio_ioctl.GPIO_V2_LINE_SET_CONFIG_IOCTL, &config) < 0) {
        napi.throwError(env, "failed to reconfigure GPIO line");
        return napi.getUndefined(env);
    }

    {
        gpio.mutex.lock();
        defer gpio.mutex.unlock();
        gpio.lines.put(offset, .{ .fd = line_fd, .edge = built.edge }) catch {};
    }

    // Spawn the poll thread only when this config enables edges; otherwise a
    // wake is enough for an existing thread to drop the line from its poll set.
    if (built.edge) ensureThreadAndWake(env, gpio) else wake(gpio);

    return napi.getUndefined(env);
}

// ---------------------------------------------------------------------------
// readLine(offset) / writeLine(offset, value) -> Promise
// ---------------------------------------------------------------------------

fn jsReadLine(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    const cb = napi.cbInfo(env, info, 1) catch return napi.getUndefined(env);
    const argv = cb.argv;
    const gpio = napi.unwrap(env, cb.this, Gpio) orelse return napi.getUndefined(env);
    if (!gpio.is_open) return napi.rejectNow(env, "Gpio is not open");

    var offset: u32 = undefined;
    if (c.napi_get_value_uint32(env, argv[0], &offset) != c.napi_ok)
        return napi.rejectNow(env, "invalid offset");

    const fd = lineFd(gpio, offset) orelse return napi.rejectNow(env, "line not requested");
    return queueWork(env, .read, fd, false);
}

fn jsWriteLine(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    const cb = napi.cbInfo(env, info, 2) catch return napi.getUndefined(env);
    const argv = cb.argv;
    const gpio = napi.unwrap(env, cb.this, Gpio) orelse return napi.getUndefined(env);
    if (!gpio.is_open) return napi.rejectNow(env, "Gpio is not open");

    var offset: u32 = undefined;
    if (c.napi_get_value_uint32(env, argv[0], &offset) != c.napi_ok)
        return napi.rejectNow(env, "invalid offset");
    const value = napi.getBool(env, argv[1]) orelse return napi.rejectNow(env, "invalid value");

    const fd = lineFd(gpio, offset) orelse return napi.rejectNow(env, "line not requested");
    return queueWork(env, .write, fd, value);
}

fn lineFd(gpio: *Gpio, offset: u32) ?std.c.fd_t {
    gpio.mutex.lock();
    defer gpio.mutex.unlock();
    const entry = gpio.lines.get(offset) orelse return null;
    return entry.fd;
}

fn queueWork(env: c.napi_env, kind: WorkKind, fd: std.c.fd_t, value: bool) c.napi_value {
    // Every path must settle the deferred: an unsettled deferred pins the
    // Promise (and every awaiter) on the JS heap forever.
    const p = napi.createPromise(env);

    const w = alloc.create(Work) catch {
        napi.reject(env, p.deferred, napi.createError(env, "out of memory"));
        return p.promise;
    };
    w.* = .{ .kind = kind, .fd = fd, .value = value, .deferred = p.deferred };

    const res_name = napi.createStringUtf8(env, "liminalGpioWork");
    if (c.napi_create_async_work(env, null, res_name, workExecute, workComplete, w, &w.work) != c.napi_ok) {
        alloc.destroy(w);
        napi.reject(env, p.deferred, napi.createError(env, "failed to create async work"));
        return p.promise;
    }
    if (c.napi_queue_async_work(env, w.work) != c.napi_ok) {
        _ = c.napi_delete_async_work(env, w.work);
        alloc.destroy(w);
        napi.reject(env, p.deferred, napi.createError(env, "failed to queue async work"));
        return p.promise;
    }
    return p.promise;
}

fn workExecute(_: c.napi_env, data: ?*anyopaque) callconv(.c) void {
    const w: *Work = @ptrCast(@alignCast(data orelse return));
    switch (w.kind) {
        .read => {
            var values: gpio_ioctl.gpio_v2_line_values = .{ .bits = 0, .mask = 1 };
            if (ioctl(w.fd, gpio_ioctl.GPIO_V2_LINE_GET_VALUES_IOCTL, &values) == 0) {
                w.value = (values.bits & 1) != 0;
                w.ok = true;
            }
        },
        .write => {
            var values: gpio_ioctl.gpio_v2_line_values = .{ .bits = if (w.value) 1 else 0, .mask = 1 };
            w.ok = ioctl(w.fd, gpio_ioctl.GPIO_V2_LINE_SET_VALUES_IOCTL, &values) == 0;
        },
    }
}

fn workComplete(env: c.napi_env, status: c.napi_status, data: ?*anyopaque) callconv(.c) void {
    const w: *Work = @ptrCast(@alignCast(data orelse return));
    defer {
        _ = c.napi_delete_async_work(env, w.work);
        alloc.destroy(w);
    }

    if (status == c.napi_ok and w.ok) {
        const result = if (w.kind == .read) napi.createBool(env, w.value) else napi.getUndefined(env);
        napi.resolve(env, w.deferred, result);
    } else {
        const text = if (w.kind == .read) "read failed" else "write failed";
        napi.reject(env, w.deferred, napi.createError(env, text));
    }
}

// ---------------------------------------------------------------------------
// releaseLine(offset)
// ---------------------------------------------------------------------------

fn jsReleaseLine(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    const cb = napi.cbInfo(env, info, 1) catch return napi.getUndefined(env);
    const argv = cb.argv;
    const gpio = napi.unwrap(env, cb.this, Gpio) orelse return napi.getUndefined(env);

    var offset: u32 = undefined;
    if (c.napi_get_value_uint32(env, argv[0], &offset) != c.napi_ok) {
        napi.throwError(env, "invalid offset");
        return napi.getUndefined(env);
    }

    var had_edge = false;
    {
        gpio.mutex.lock();
        defer gpio.mutex.unlock();
        if (gpio.lines.fetchRemove(offset)) |kv| {
            _ = close(kv.value.fd);
            had_edge = kv.value.edge;
        }
    }
    if (had_edge) wake(gpio);

    return napi.getUndefined(env);
}

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

fn jsClose(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    const cb = napi.cbInfo(env, info, 0) catch return napi.getUndefined(env);
    const gpio = napi.unwrap(env, cb.this, Gpio) orelse return napi.getUndefined(env);
    shutdown(gpio);
    return napi.getUndefined(env);
}

/// Idempotent teardown: stop the event thread, release the TSFN, close all fds.
fn shutdown(gpio: *Gpio) void {
    if (!gpio.is_open) return;
    gpio.is_open = false;
    gpio.stop.store(true, .seq_cst);

    if (gpio.wake_w >= 0) {
        const one = [_]u8{0};
        _ = write(gpio.wake_w, &one, 1);
    }
    if (gpio.thread) |t| {
        t.join();
        gpio.thread = null;
    }
    if (gpio.tsfn != null) {
        _ = c.napi_release_threadsafe_function(gpio.tsfn, c.napi_tsfn_release);
        gpio.tsfn = null;
    }

    {
        gpio.mutex.lock();
        defer gpio.mutex.unlock();
        var it = gpio.lines.valueIterator();
        while (it.next()) |entry| _ = close(entry.fd);
        gpio.lines.clearRetainingCapacity();
    }

    if (gpio.chip_fd >= 0) {
        _ = close(gpio.chip_fd);
        gpio.chip_fd = -1;
    }
    if (gpio.wake_r >= 0) {
        _ = close(gpio.wake_r);
        gpio.wake_r = -1;
    }
    if (gpio.wake_w >= 0) {
        _ = close(gpio.wake_w);
        gpio.wake_w = -1;
    }
}

// ---------------------------------------------------------------------------
// Event thread
// ---------------------------------------------------------------------------

fn ensureThreadAndWake(env: c.napi_env, gpio: *Gpio) void {
    if (gpio.thread == null) {
        gpio.thread = std.Thread.spawn(.{}, eventLoop, .{gpio}) catch {
            napi.throwError(env, "failed to spawn GPIO event thread");
            return;
        };
    } else {
        wake(gpio);
    }
}

fn wake(gpio: *Gpio) void {
    if (gpio.wake_w >= 0) {
        const one = [_]u8{0};
        _ = write(gpio.wake_w, &one, 1);
    }
}

fn eventLoop(gpio: *Gpio) void {
    var event: gpio_ioctl.gpio_v2_line_event = undefined;

    while (!gpio.stop.load(.seq_cst)) {
        var fds: [gpio_ioctl.GPIO_V2_LINES_MAX + 1]std.c.pollfd = undefined;
        var nfds: usize = 0;

        {
            gpio.mutex.lock();
            defer gpio.mutex.unlock();
            var it = gpio.lines.valueIterator();
            while (it.next()) |entry| {
                if (!entry.edge) continue;
                if (nfds >= gpio_ioctl.GPIO_V2_LINES_MAX) break;
                fds[nfds] = .{ .fd = entry.fd, .events = std.c.POLL.IN, .revents = 0 };
                nfds += 1;
            }
        }
        const wake_idx = nfds;
        fds[wake_idx] = .{ .fd = gpio.wake_r, .events = std.c.POLL.IN, .revents = 0 };
        nfds += 1;

        const rc = poll(&fds, @intCast(nfds), -1);
        if (rc < 0) continue;

        if (fds[wake_idx].revents != 0) {
            var drain_buf: [64]u8 = undefined;
            _ = read(gpio.wake_r, &drain_buf, drain_buf.len);
            continue; // re-poll with a fresh fd set
        }

        for (fds[0..wake_idx]) |pfd| {
            if (pfd.revents & std.c.POLL.IN == 0) continue;
            const n = read(pfd.fd, std.mem.asBytes(&event), @sizeOf(gpio_ioctl.gpio_v2_line_event));
            if (n != @sizeOf(gpio_ioctl.gpio_v2_line_event)) continue;

            const value = event.id == gpio_ioctl.EVENT_RISING_EDGE;
            const chunk = alloc.create(Chunk) catch continue;
            chunk.* = .{ .offset = event.offset, .value = value, .timestamp_ns = event.timestamp_ns };
            if (c.napi_call_threadsafe_function(gpio.tsfn, chunk, c.napi_tsfn_nonblocking) != c.napi_ok) {
                alloc.destroy(chunk);
            }
        }
    }
}

/// Runs on the JS/main thread. Delivers onEvent(offset, value, timestamp).
fn callJs(env: c.napi_env, js_cb: c.napi_value, _: ?*anyopaque, data: ?*anyopaque) callconv(.c) void {
    const chunk: *Chunk = @ptrCast(@alignCast(data orelse return));
    defer alloc.destroy(chunk);
    // env is null when the environment is tearing down; skip the call.
    if (env == null or js_cb == null) return;

    var args = [_]c.napi_value{
        napi.createU32(env, chunk.offset),
        napi.createBool(env, chunk.value),
        napi.createBigInt(env, chunk.timestamp_ns),
    };
    _ = c.napi_call_function(env, napi.getUndefined(env), js_cb, args.len, &args, null);
}

// ---------------------------------------------------------------------------
// Config object -> gpio_v2_line_config
// ---------------------------------------------------------------------------

const BuiltConfig = struct {
    config: gpio_ioctl.gpio_v2_line_config,
    edge: bool,
};

fn buildLineConfig(env: c.napi_env, config_obj: c.napi_value) BuiltConfig {
    var flags: u64 = 0;

    var dir_buf: [8]u8 = undefined;
    const direction = napi.getNamedStringUtf8(env, config_obj, "direction", &dir_buf) orelse "in";
    if (std.mem.eql(u8, direction, "out")) flags |= gpio_ioctl.FLAG_OUTPUT else flags |= gpio_ioctl.FLAG_INPUT;

    if (napi.getNamedBool(env, config_obj, "pullup") orelse false) flags |= gpio_ioctl.FLAG_BIAS_PULL_UP;
    if (napi.getNamedBool(env, config_obj, "pulldown") orelse false) flags |= gpio_ioctl.FLAG_BIAS_PULL_DOWN;
    if (napi.getNamedBool(env, config_obj, "activeLow") orelse false) flags |= gpio_ioctl.FLAG_ACTIVE_LOW;
    if (napi.getNamedBool(env, config_obj, "openDrain") orelse false) flags |= gpio_ioctl.FLAG_OPEN_DRAIN;
    if (napi.getNamedBool(env, config_obj, "openSource") orelse false) flags |= gpio_ioctl.FLAG_OPEN_SOURCE;

    var edge_buf: [8]u8 = undefined;
    var edge = false;
    if (napi.getNamedStringUtf8(env, config_obj, "edge", &edge_buf)) |e| {
        edge = true;
        if (std.mem.eql(u8, e, "rising")) {
            flags |= gpio_ioctl.FLAG_EDGE_RISING;
        } else if (std.mem.eql(u8, e, "falling")) {
            flags |= gpio_ioctl.FLAG_EDGE_FALLING;
        } else if (std.mem.eql(u8, e, "both")) {
            flags |= gpio_ioctl.FLAG_EDGE_RISING | gpio_ioctl.FLAG_EDGE_FALLING;
        } else {
            edge = false;
        }
    }

    var config: gpio_ioctl.gpio_v2_line_config = std.mem.zeroes(gpio_ioctl.gpio_v2_line_config);
    config.flags = flags;

    var num_attrs: u32 = 0;
    if (napi.getNamedF64(env, config_obj, "debounce")) |debounce_us| {
        config.attrs[num_attrs] = .{
            .attr = .{ .id = gpio_ioctl.ATTR_ID_DEBOUNCE, .padding = 0, .value = @intFromFloat(debounce_us) },
            .mask = 1,
        };
        num_attrs += 1;
    }
    if (std.mem.eql(u8, direction, "out")) {
        if (napi.getNamedBool(env, config_obj, "initialValue")) |initial| {
            config.attrs[num_attrs] = .{
                .attr = .{ .id = gpio_ioctl.ATTR_ID_OUTPUT_VALUES, .padding = 0, .value = if (initial) 1 else 0 },
                .mask = 1,
            };
            num_attrs += 1;
        }
    }
    config.num_attrs = num_attrs;

    return .{ .config = config, .edge = edge };
}
