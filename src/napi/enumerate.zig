//! GPIO chip enumeration (Linux `/dev/gpiochip*`) and header-chip detection.
//!
//! We scan `/dev` directly (libc opendir/readdir) rather than any framework
//! API, which keeps cross-compilation clean. Non-Linux targets return an
//! empty list (see `scan`).
const std = @import("std");
const builtin = @import("builtin");
const gpio_ioctl = @import("gpio_ioctl.zig");

pub const Entry = struct {
    /// Heap-allocated absolute device path, e.g. "/dev/gpiochip0".
    path: []u8,
    /// Heap-allocated device name, e.g. "gpiochip0".
    name: []u8,
    /// Heap-allocated driver label, e.g. "pinctrl-bcm2711".
    label: []u8,
    /// Number of lines on the chip.
    lines: u32,
};

// readdir is not exposed as `pub` by std.c, so declare it ourselves.
extern "c" fn readdir(dir: *std.c.DIR) ?*std.c.dirent;
extern "c" fn close(fd: std.c.fd_t) c_int;
extern "c" fn ioctl(fd: std.c.fd_t, request: c_ulong, ...) c_int;

/// Labels of the 40-pin header gpiochip across Pi 3 / 4 / 5.
const header_labels = [_][]const u8{ "pinctrl-bcm2835", "pinctrl-bcm2711", "pinctrl-rp1" };

pub fn scan(allocator: std.mem.Allocator) ![]Entry {
    var list: std.ArrayList(Entry) = .empty;
    errdefer free(allocator, list.items);

    if (builtin.os.tag == .linux) try scanDev(allocator, &list);

    return list.toOwnedSlice(allocator);
}

pub fn free(allocator: std.mem.Allocator, entries: []Entry) void {
    for (entries) |e| {
        allocator.free(e.path);
        allocator.free(e.name);
        allocator.free(e.label);
    }
    allocator.free(entries);
}

/// Returns the /dev path of the 40-pin header gpiochip, or null if not found.
/// Caller owns the returned slice.
///
/// Some kernels expose more than one chip with a header label (e.g. recent
/// Raspberry Pi OS shows two `pinctrl-bcm2835` 54-line chips — gpiochip0 and a
/// higher-indexed alias — that drive the same header). We pick the
/// **lowest-numbered** match so detection is deterministic across boots/scans
/// rather than dependent on readdir order.
pub fn detectHeaderChip(allocator: std.mem.Allocator) !?[]u8 {
    const entries = try scan(allocator);
    defer free(allocator, entries);

    var best: ?*const Entry = null;
    var best_index: u32 = std.math.maxInt(u32);
    for (entries) |*e| {
        if (!isHeaderLabel(e.label)) continue;
        const idx = chipIndex(e.name) orelse continue;
        if (idx < best_index) {
            best_index = idx;
            best = e;
        }
    }
    if (best) |e| return try allocator.dupe(u8, e.path);
    return null;
}

fn isHeaderLabel(label: []const u8) bool {
    for (header_labels) |l| {
        if (std.mem.eql(u8, label, l)) return true;
    }
    return false;
}

/// Parses the trailing integer of a "gpiochipN" name; null if malformed.
fn chipIndex(name: []const u8) ?u32 {
    const prefix = "gpiochip";
    if (!std.mem.startsWith(u8, name, prefix)) return null;
    return std.fmt.parseInt(u32, name[prefix.len..], 10) catch null;
}

fn scanDev(allocator: std.mem.Allocator, list: *std.ArrayList(Entry)) !void {
    const dir = std.c.opendir("/dev") orelse return;
    defer _ = std.c.closedir(dir);

    while (readdir(dir)) |ent| {
        const name = std.mem.sliceTo(&ent.name, 0);
        if (!std.mem.startsWith(u8, name, "gpiochip")) continue;

        const path = try std.fmt.allocPrintSentinel(allocator, "/dev/{s}", .{name}, 0);
        defer allocator.free(path);

        const fd = std.c.open(path.ptr, std.c.O{ .ACCMODE = .RDONLY }, @as(std.c.mode_t, 0));
        if (fd < 0) continue;
        defer _ = close(fd);

        var info: gpio_ioctl.gpiochip_info = std.mem.zeroes(gpio_ioctl.gpiochip_info);
        if (ioctl(fd, gpio_ioctl.GPIO_GET_CHIPINFO_IOCTL, &info) != 0) continue;

        const name_copy = try allocator.dupe(u8, name);
        errdefer allocator.free(name_copy);
        const path_copy = try allocator.dupe(u8, path);
        errdefer allocator.free(path_copy);
        const label_copy = try allocator.dupe(u8, std.mem.sliceTo(&info.label, 0));
        errdefer allocator.free(label_copy);

        try list.append(allocator, .{
            .path = path_copy,
            .name = name_copy,
            .label = label_copy,
            .lines = info.lines,
        });
    }
}
