const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "frameos-zig",
        .root_source_file = .{ .path = "src/main.zig" },
        .target = target,
        .optimize = optimize,
    });

    const scene_renderer = b.addExecutable(.{
        .name = "scene_renderer",
        .root_source_file = .{ .path = "src/scene_renderer.zig" },
        .target = target,
        .optimize = optimize,
    });

    b.installArtifact(exe);
    b.installArtifact(scene_renderer);

    const tests = b.addTest(.{
        .root_source_file = .{ .path = "src/main.zig" },
        .target = target,
        .optimize = optimize,
    });

    const test_run = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run runtime unit tests");
    test_step.dependOn(&test_run.step);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run the Zig runtime stub");
    run_step.dependOn(&run_cmd.step);
}
