const std = @import("std");
const config_mod = @import("runtime/config.zig");
const event_loop_mod = @import("runtime/event_loop.zig");
const logger_mod = @import("runtime/logger.zig");
const metrics_mod = @import("runtime/metrics.zig");
const platform_mod = @import("runtime/platform.zig");
const runner_mod = @import("runtime/runner.zig");
const scheduler_mod = @import("runtime/scheduler.zig");
const scenes_mod = @import("runtime/scenes.zig");
const server_mod = @import("runtime/server.zig");
const health_mod = @import("runtime/health.zig");
const system_mod = @import("system/mod.zig");

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

    const driver_platform = platform_mod.DriverPlatform.init(allocator, logger, config.device);
    try driver_platform.initDrivers();

    const scene_registry = scenes_mod.SceneRegistry.init(logger, config.startup_scene);
    try scene_registry.startup();

    const system_scene = system_mod.defaultStartupScene(config);
    try logger.info(
        "{\"event\":\"system.scene.default\",\"scene\":\"{s}\",\"networkCheck\":{}}",
        .{ system_mod.startupSceneLabel(system_scene), config.network_check },
    );

    const system_services = system_mod.SystemServices.init(logger, config.frame_host, config.frame_port, config.device, system_scene);
    try system_services.startup();

    var health = health_mod.RuntimeHealth.init(logger, config.network_check);

    const runner = runner_mod.RuntimeRunner.init(logger, config.device, scene_registry);
    try runner.startup();
    health.markRunnerReady();

    const scheduler = scheduler_mod.RuntimeScheduler.init(logger);
    try scheduler.startup();
    health.markSchedulerReady();

    const server = server_mod.RuntimeServer.init(logger, config);
    try server.startup();

    health.markServerStarted();
    if (!config.network_check) {
        health.recordNetworkProbe(true);
    }

    const health_snapshot = health.snapshot();
    var health_route_buffer: [256]u8 = undefined;
    const health_route_payload = try server.healthRoute(health_snapshot).renderJson(&health_route_buffer);
    try logger.info(
        "{\"event\":\"server.route.payload\",\"route\":\"/health\",\"payload\":{s}}",
        .{health_route_payload},
    );

    var scenes_route_buffer: [512]u8 = undefined;
    const scenes_route_payload = try server.scenesRoute(scene_registry).renderJson(&scenes_route_buffer);
    try logger.info(
        "{\"event\":\"server.route.payload\",\"route\":\"/scenes\",\"payload\":{s}}",
        .{scenes_route_payload},
    );

    try health.startup();

    const loop = event_loop_mod.RuntimeEventLoop.init(logger, std.time.ns_per_s);
    try loop.run();
}
