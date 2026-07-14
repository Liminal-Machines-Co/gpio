const std = @import("std");

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Translate the official Node-API C header into a Zig module named "c".
    // N-API symbols are resolved by Node at load time, so we never link libnode
    // and no per-platform Node headers are needed — this is what makes Zig's
    // cross-compilation "just work" for the addon.
    const napi_headers = b.dependency("node_api_headers", .{});
    const translate_c = b.addTranslateC(.{
        .root_source_file = napi_headers.path("include/node_api.h"),
        .target = target,
        .optimize = optimize,
    });
    translate_c.addIncludePath(napi_headers.path("include"));
    const napi_c = translate_c.createModule();

    const root_mod = b.createModule(.{
        .root_source_file = b.path("src/napi/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .strip = optimize != .Debug,
        .imports = &.{
            .{ .name = "c", .module = napi_c },
        },
    });

    // On Windows, DLLs must resolve imports at link time — unlike ELF/Mach-O
    // where N-API symbols stay undefined until load. Generate an import library
    // from the node_api.def shipped by node-api-headers (symbols imported from
    // node.exe) and link it.
    if (target.result.os.tag == .windows) {
        const machine = switch (target.result.cpu.arch) {
            .x86_64 => "i386:x86-64",
            .aarch64 => "arm64",
            .x86 => "i386",
            else => "i386:x86-64",
        };
        const dlltool = b.addSystemCommand(&.{ b.graph.zig_exe, "dlltool" });
        dlltool.addArgs(&.{ "-m", machine, "-D", "node.exe", "-d" });
        dlltool.addFileArg(napi_headers.path("def/node_api.def"));
        dlltool.addArg("-l");
        const implib = dlltool.addOutputFileArg("node_api.lib");
        root_mod.addObjectFile(implib);
    }

    const lib = b.addLibrary(.{
        .name = "gpio",
        .root_module = root_mod,
        .linkage = .dynamic,
    });
    // N-API symbols are undefined until the addon is loaded by Node.
    lib.linker_allow_shlib_undefined = true;

    // Lay the binary out where node-gyp-build expects it:
    //   prebuilds/<platform>-<arch>/gpio.node
    // Run with `zig build --prefix .` so the install prefix is the repo root.
    const platform_arch = try nodePlatformArch(b.allocator, target.result);
    const dest_dir = try std.fmt.allocPrint(b.allocator, "prebuilds/{s}", .{platform_arch});

    const install = b.addInstallArtifact(lib, .{
        .dest_dir = .{ .override = .{ .custom = dest_dir } },
        .dest_sub_path = "gpio.node",
    });
    b.getInstallStep().dependOn(&install.step);
}

/// Maps a Zig target to Node's `${process.platform}-${process.arch}` naming,
/// which is the directory layout node-gyp-build resolves against.
fn nodePlatformArch(allocator: std.mem.Allocator, target: std.Target) ![]const u8 {
    const platform = switch (target.os.tag) {
        .macos => "darwin",
        .linux => "linux",
        .windows => "win32",
        .freebsd => "freebsd",
        else => @tagName(target.os.tag),
    };
    const arch = switch (target.cpu.arch) {
        .aarch64, .aarch64_be => "arm64",
        .x86_64 => "x64",
        .x86 => "ia32",
        .arm => "arm",
        else => @tagName(target.cpu.arch),
    };
    return std.fmt.allocPrint(allocator, "{s}-{s}", .{ platform, arch });
}
