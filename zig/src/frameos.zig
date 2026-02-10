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

pub const BootRoutePayloads = struct {
    health: []const u8,
    scenes: []const u8,
    startup_scene: []const u8,
};

pub fn renderBootRoutePayloads(
    server: server_mod.RuntimeServer,
    scene_registry: scenes_mod.SceneRegistry,
    health_snapshot: health_mod.HealthSnapshot,
    health_buf: []u8,
    scenes_buf: []u8,
    startup_scene_buf: []u8,
) !BootRoutePayloads {
    return .{
        .health = try server.healthRoute(health_snapshot).renderJson(health_buf),
        .scenes = try server.scenesRoute(scene_registry).renderJson(scenes_buf),
        .startup_scene = try server.sceneByIdRoute(scene_registry, scene_registry.startup_scene).renderJson(startup_scene_buf),
    };
}

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
    const startup_state = system_mod.startupStateFromConfig(config);
    try logger.info(
        "{\"event\":\"system.scene.default\",\"scene\":\"{s}\",\"state\":\"{s}\",\"networkCheck\":{}}",
        .{ system_mod.startupSceneLabel(system_scene), system_mod.startupStateLabel(startup_state), config.network_check },
    );

    const system_services = system_mod.SystemServices.init(logger, config.frame_host, config.frame_port, config.device, system_scene, startup_state);
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
    var scenes_route_buffer: [512]u8 = undefined;
    var startup_scene_route_buffer: [256]u8 = undefined;
    const route_payloads = try renderBootRoutePayloads(
        server,
        scene_registry,
        health_snapshot,
        &health_route_buffer,
        &scenes_route_buffer,
        &startup_scene_route_buffer,
    );

    try logger.info(
        "{\"event\":\"server.route.payload\",\"route\":\"/health\",\"payload\":{s}}",
        .{route_payloads.health},
    );

    try logger.info(
        "{\"event\":\"server.route.payload\",\"route\":\"/scenes\",\"payload\":{s}}",
        .{route_payloads.scenes},
    );

    try logger.info(
        "{\"event\":\"server.route.payload\",\"route\":\"/scenes/:id\",\"requestedId\":\"{s}\",\"payload\":{s}}",
        .{ scene_registry.startup_scene, route_payloads.startup_scene },
    );

    try health.startup();

    const loop = event_loop_mod.RuntimeEventLoop.init(logger, std.time.ns_per_s);
    try loop.run();
}

test "boot payload integration captures health and scene snapshots" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "unknown-scene",
    });

    const config: config_mod.RuntimeConfig = .{
        .frame_host = "0.0.0.0",
        .frame_port = 7777,
        .debug = false,
        .metrics_interval_s = 30,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "unknown-scene",
    };

    const server = server_mod.RuntimeServer.init(logger, config);
    const registry = scenes_mod.SceneRegistry.init(logger, config.startup_scene);

    var health = health_mod.RuntimeHealth.init(logger, true);
    health.markServerStarted();
    health.markRunnerReady();
    health.markSchedulerReady();
    health.recordNetworkProbe(true);

    var health_buf: [256]u8 = undefined;
    var scenes_buf: [512]u8 = undefined;
    var startup_scene_buf: [256]u8 = undefined;

    const payloads = try renderBootRoutePayloads(server, registry, health.snapshot(), &health_buf, &scenes_buf, &startup_scene_buf);

    try testing.expect(std.mem.indexOf(u8, payloads.health, "\"status\":\"ok\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.scenes, "\"id\":\"clock\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.startup_scene, "\"found\":false") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.startup_scene, "\"code\":\"scene_not_found\"") != null);
}
