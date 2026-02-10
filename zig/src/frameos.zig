const std = @import("std");
const config_mod = @import("runtime/config.zig");
const event_loop_mod = @import("runtime/event_loop.zig");
const health_mod = @import("runtime/health.zig");
const logger_mod = @import("runtime/logger.zig");
const metrics_mod = @import("runtime/metrics.zig");
const network_probe_mod = @import("runtime/network_probe.zig");
const platform_mod = @import("runtime/platform.zig");
const runner_mod = @import("runtime/runner.zig");
const scheduler_mod = @import("runtime/scheduler.zig");
const scenes_mod = @import("runtime/scenes.zig");
const server_mod = @import("runtime/server.zig");
const system_mod = @import("system/mod.zig");

pub const BootRoutePayloads = struct {
    health: []const u8,
    scenes: []const u8,
    startup_scene: []const u8,
    hotspot_status: []const u8,
    device_summary: []const u8,
};

pub fn renderBootRoutePayloads(
    server: server_mod.RuntimeServer,
    scene_registry: scenes_mod.SceneRegistry,
    health_snapshot: health_mod.HealthSnapshot,
    probe_mode: config_mod.NetworkProbeMode,
    probe_outcome: ?network_probe_mod.ProbeOutcome,
    system_services: system_mod.SystemServices,
    startup_state: system_mod.SystemStartupState,
    health_buf: []u8,
    scenes_buf: []u8,
    startup_scene_buf: []u8,
    hotspot_status_buf: []u8,
    device_summary_buf: []u8,
) !BootRoutePayloads {
    const startup_scene_route = try server.sceneByIdRoute(scene_registry, scene_registry.startup_scene);

    return .{
        .health = try server.healthRoute(health_snapshot, probe_mode, probe_outcome).renderJson(health_buf),
        .scenes = try server.scenesRoute(scene_registry).renderJson(scenes_buf),
        .startup_scene = try startup_scene_route.renderJson(startup_scene_buf),
        .hotspot_status = try server.hotspotPortalStatusRoute(system_services.hotspot, system_services.portal, startup_state, system_mod.startupSceneLabel(system_services.hotspot.startup_scene)).renderJson(hotspot_status_buf),
        .device_summary = try server.deviceSummaryRoute(system_services.device_utils, scene_registry.startup_scene, startup_state).renderJson(device_summary_buf),
    };
}

pub fn renderBootNetworkProbePayload(
    host: []const u8,
    port: u16,
    probe_mode: config_mod.NetworkProbeMode,
    probe_outcome: network_probe_mod.ProbeOutcome,
    buffer: []u8,
) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    const writer = stream.writer();
    try writer.print(
        "{\"target\":{\"host\":\"{s}\",\"port\":{}},\"mode\":\"{s}\",\"outcome\":\"{s}\"}",
        .{ host, port, config_mod.probeModeLabel(probe_mode), network_probe_mod.outcomeLabel(probe_outcome) },
    );

    return stream.getWritten();
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
    const initial_startup_state = system_mod.startupStateFromConfig(config);
    try logger.info(
        "{\"event\":\"system.scene.default\",\"scene\":\"{s}\",\"state\":\"{s}\",\"networkCheck\":{}}",
        .{ system_mod.startupSceneLabel(system_scene), system_mod.startupStateLabel(initial_startup_state), config.network_check },
    );

    const system_services = system_mod.SystemServices.init(logger, config.frame_host, config.frame_port, config.device, system_scene, initial_startup_state);
    try system_services.startup();

    var health = health_mod.RuntimeHealth.init(logger, config.network_check, mapStartupState(initial_startup_state));

    const runner = runner_mod.RuntimeRunner.init(logger, config.device, scene_registry);
    try runner.startup();
    health.markRunnerReady();

    const scheduler = scheduler_mod.RuntimeScheduler.init(logger);
    try scheduler.startup();
    health.markSchedulerReady();

    const server = server_mod.RuntimeServer.init(logger, config);
    try server.startup();

    const network_probe = network_probe_mod.RuntimeNetworkProbe.init(logger, config.network_check, config.network_probe_mode);
    try network_probe.startup();

    health.markServerStarted();
    const probe_outcome = try network_probe.probe(.{ .host = config.frame_host, .port = config.frame_port });
    var network_probe_payload_buf: [160]u8 = undefined;
    const network_probe_payload = try renderBootNetworkProbePayload(
        config.frame_host,
        config.frame_port,
        config.network_probe_mode,
        probe_outcome,
        &network_probe_payload_buf,
    );
    try logger.info("{\"event\":\"boot.network_probe\",\"payload\":{s}}", .{network_probe_payload});
    health.recordNetworkProbe(probe_outcome != .failed);

    const health_snapshot = health.snapshot();
    const runtime_startup_state = mapHealthStartupState(health_snapshot.startup_state);

    var health_route_buffer: [256]u8 = undefined;
    var scenes_route_buffer: [512]u8 = undefined;
    var startup_scene_route_buffer: [256]u8 = undefined;
    var hotspot_status_route_buffer: [256]u8 = undefined;
    var device_summary_route_buffer: [320]u8 = undefined;
    const route_payloads = try renderBootRoutePayloads(
        server,
        scene_registry,
        health_snapshot,
        config.network_probe_mode,
        probe_outcome,
        system_services,
        runtime_startup_state,
        &health_route_buffer,
        &scenes_route_buffer,
        &startup_scene_route_buffer,
        &hotspot_status_route_buffer,
        &device_summary_route_buffer,
    );

    try logger.info("{\"event\":\"server.route.payload\",\"route\":\"/health\",\"payload\":{s}}", .{route_payloads.health});
    try logger.info("{\"event\":\"server.route.payload\",\"route\":\"/scenes\",\"payload\":{s}}", .{route_payloads.scenes});
    try logger.info("{\"event\":\"server.route.payload\",\"route\":\"/scenes/:id\",\"requestedId\":\"{s}\",\"payload\":{s}}", .{ scene_registry.startup_scene, route_payloads.startup_scene });
    try logger.info("{\"event\":\"server.route.payload\",\"route\":\"/system/hotspot\",\"payload\":{s}}", .{route_payloads.hotspot_status});
    try logger.info("{\"event\":\"server.route.payload\",\"route\":\"/system/device\",\"payload\":{s}}", .{route_payloads.device_summary});

    try health.startup();

    const loop = event_loop_mod.RuntimeEventLoop.init(logger, std.time.ns_per_s);
    try loop.run();
}

fn mapStartupState(state: system_mod.SystemStartupState) health_mod.StartupState {
    return switch (state) {
        .booting => .booting,
        .degraded_network => .degraded_network,
        .ready => .ready,
    };
}

fn mapHealthStartupState(state: health_mod.StartupState) system_mod.SystemStartupState {
    return switch (state) {
        .booting => .booting,
        .degraded_network => .degraded_network,
        .ready => .ready,
    };
}

test "boot payload integration captures health and scene snapshots" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "unknown-scene" });

    const config: config_mod.RuntimeConfig = .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "unknown-scene" };

    const server = server_mod.RuntimeServer.init(logger, config);
    const registry = scenes_mod.SceneRegistry.init(logger, config.startup_scene);
    const startup_scene = system_mod.defaultStartupScene(config);
    const startup_state = system_mod.startupStateFromConfig(config);
    const services = system_mod.SystemServices.init(logger, config.frame_host, config.frame_port, config.device, startup_scene, startup_state);

    var health = health_mod.RuntimeHealth.init(logger, true, .booting);
    health.markServerStarted();
    health.markRunnerReady();
    health.markSchedulerReady();
    health.recordNetworkProbe(false);

    var health_buf: [256]u8 = undefined;
    var scenes_buf: [512]u8 = undefined;
    var startup_scene_buf: [256]u8 = undefined;
    var hotspot_status_buf: [256]u8 = undefined;
    var device_summary_buf: [320]u8 = undefined;

    const payloads = try renderBootRoutePayloads(
        server,
        registry,
        health.snapshot(),
        config.network_probe_mode,
        .failed,
        services,
        mapHealthStartupState(health.snapshot().startup_state),
        &health_buf,
        &scenes_buf,
        &startup_scene_buf,
        &hotspot_status_buf,
        &device_summary_buf,
    );

    try testing.expect(std.mem.indexOf(u8, payloads.health, "\"status\":\"degraded\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.health, "\"startupState\":\"degraded-network\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.health, "\"networkProbe\":{\"mode\":\"auto\",\"outcome\":\"failed\"}") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.scenes, "\"id\":\"clock\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.startup_scene, "\"found\":false") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.startup_scene, "\"code\":\"scene_not_found\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.hotspot_status, "\"startupScene\":\"index\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.hotspot_status, "\"startupState\":\"degraded-network\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.hotspot_status, "\"hotspotActive\":false") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.device_summary, "\"startupScene\":\"unknown-scene\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.device_summary, "\"startupState\":\"degraded-network\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.device_summary, "\"kind\":\"simulator\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.device_summary, "\"summary\":\"FrameOS Device (simulator) 800x480 @ 0°\"") != null);
}

test "boot payload integration captures successful startup scene payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "weather" });

    const config: config_mod.RuntimeConfig = .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "weather" };

    const server = server_mod.RuntimeServer.init(logger, config);
    const registry = scenes_mod.SceneRegistry.init(logger, config.startup_scene);
    const startup_scene = system_mod.defaultStartupScene(config);
    const startup_state = system_mod.startupStateFromConfig(config);
    const services = system_mod.SystemServices.init(logger, config.frame_host, config.frame_port, config.device, startup_scene, startup_state);

    var health = health_mod.RuntimeHealth.init(logger, true, .booting);
    health.markServerStarted();
    health.markRunnerReady();
    health.markSchedulerReady();
    health.recordNetworkProbe(true);

    var health_buf: [256]u8 = undefined;
    var scenes_buf: [512]u8 = undefined;
    var startup_scene_buf: [256]u8 = undefined;
    var hotspot_status_buf: [256]u8 = undefined;
    var device_summary_buf: [320]u8 = undefined;

    const payloads = try renderBootRoutePayloads(
        server,
        registry,
        health.snapshot(),
        config.network_probe_mode,
        .ok,
        services,
        mapHealthStartupState(health.snapshot().startup_state),
        &health_buf,
        &scenes_buf,
        &startup_scene_buf,
        &hotspot_status_buf,
        &device_summary_buf,
    );

    try testing.expect(std.mem.indexOf(u8, payloads.startup_scene, "\"found\":true") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.startup_scene, "\"appId\":\"app.weather\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.startup_scene, "\"entrypoint\":\"apps/weather/main\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.startup_scene, "\"appLifecycle\":{\"appId\":\"app.weather\",\"lifecycle\":\"weather\",\"frameRateHz\":30}") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.health, "\"networkProbe\":{\"mode\":\"auto\",\"outcome\":\"ok\"}") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.device_summary, "\"startupScene\":\"weather\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.device_summary, "\"startupState\":\"ready\"") != null);
    try testing.expect(std.mem.indexOf(u8, payloads.device_summary, "\"rotationDeg\":0") != null);
}


test "boot network probe log payload aligns with health diagnostics" {
    const testing = std.testing;

    const config: config_mod.RuntimeConfig = .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .force_failed, .device = "simulator", .startup_scene = "clock" };
    const logger = logger_mod.RuntimeLogger.init(config);
    const server = server_mod.RuntimeServer.init(logger, config);

    var health = health_mod.RuntimeHealth.init(logger, true, .booting);
    health.markServerStarted();
    health.markRunnerReady();
    health.markSchedulerReady();
    health.recordNetworkProbe(false);

    var health_buf: [256]u8 = undefined;
    const health_payload = try server.healthRoute(health.snapshot(), config.network_probe_mode, .failed).renderJson(&health_buf);

    var probe_buf: [160]u8 = undefined;
    const probe_payload = try renderBootNetworkProbePayload(config.frame_host, config.frame_port, config.network_probe_mode, .failed, &probe_buf);

    try testing.expect(std.mem.indexOf(u8, health_payload, "\"networkProbe\":{\"mode\":\"force-failed\",\"outcome\":\"failed\"}") != null);
    try testing.expect(std.mem.indexOf(u8, probe_payload, "\"mode\":\"force-failed\"") != null);
    try testing.expect(std.mem.indexOf(u8, probe_payload, "\"outcome\":\"failed\"") != null);
}
