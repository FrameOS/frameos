const std = @import("std");
const config_mod = @import("runtime/config.zig");
const event_loop_mod = @import("runtime/event_loop.zig");
const logger_mod = @import("runtime/logger.zig");
const metrics_mod = @import("runtime/metrics.zig");
const platform_mod = @import("runtime/platform.zig");
const scheduler_mod = @import("runtime/scheduler.zig");

pub fn startFrameOS() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const config = try config_mod.loadConfig(allocator);
    defer config_mod.deinitConfig(allocator, config);

    const logger = logger_mod.RuntimeLogger.init(config);
    try logger.startup();
    try logger.bootup(config);

    const metrics = metrics_mod.RuntimeMetrics.init(logger, config.metrics_interval_s);
    try metrics.startup();

    const driver_platform = platform_mod.DriverPlatform.init(logger);
    try driver_platform.initDrivers();

    const scheduler = scheduler_mod.RuntimeScheduler.init(logger);
    try scheduler.startup();

    const loop = event_loop_mod.RuntimeEventLoop.init(logger, std.time.ns_per_s);
    try loop.run();
}
