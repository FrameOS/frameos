const std = @import("std");
const config_mod = @import("config.zig");
const health_mod = @import("health.zig");
const logger_mod = @import("logger.zig");
const network_probe_mod = @import("network_probe.zig");
const scenes_mod = @import("scenes.zig");
const system_mod = @import("../system/mod.zig");
const apps_mod = @import("../apps/mod.zig");

pub const RuntimeServer = struct {
    logger: logger_mod.RuntimeLogger,
    config: config_mod.RuntimeConfig,

    pub fn init(logger: logger_mod.RuntimeLogger, config: config_mod.RuntimeConfig) RuntimeServer {
        return .{
            .logger = logger,
            .config = config,
        };
    }

    pub fn startup(self: RuntimeServer) !void {
        try self.logger.info(
            "{\"event\":\"server.start\",\"status\":\"stub\",\"host\":\"{s}\",\"port\":{},\"networkCheck\":{}}",
            .{ self.config.frame_host, self.config.frame_port, self.config.network_check },
        );

        for (registeredRoutes()) |route| {
            try self.logger.info("{\"event\":\"server.route\",\"route\":\"{s}\",\"status\":\"stub\",\"method\":\"GET\"}", .{route});
        }
    }

    pub fn registeredRoutes() []const []const u8 {
        return &[_][]const u8{
            "/health",
            "/scenes",
            "/scenes/:id",
            "/scenes/:id/settings",
            "/system/hotspot",
            "/system/device",
        };
    }

    pub fn healthRoute(
        self: RuntimeServer,
        snapshot: health_mod.HealthSnapshot,
        probe_mode: config_mod.NetworkProbeMode,
        probe_outcome: ?network_probe_mod.ProbeOutcome,
    ) HealthRoute {
        return .{ .server = self, .snapshot = snapshot, .probe_mode = probe_mode, .probe_outcome = probe_outcome };
    }

    pub fn scenesRoute(self: RuntimeServer, registry: scenes_mod.SceneRegistry) ScenesRoute {
        return .{ .server = self, .registry = registry };
    }

    pub fn sceneByIdRoute(self: RuntimeServer, registry: scenes_mod.SceneRegistry, scene_id: []const u8) !SceneByIdRoute {
        return .{
            .server = self,
            .result = registry.loadManifestResult(scene_id),
            .app_lifecycle = try apps_mod.appLifecycleSummaryForScene(scene_id, .{ .allocator = std.heap.page_allocator }),
        };
    }

    pub fn sceneSettingsByIdRoute(self: RuntimeServer, registry: scenes_mod.SceneRegistry, scene_id: []const u8) SceneSettingsByIdRoute {
        return .{
            .server = self,
            .result = registry.loadManifestResult(scene_id),
        };
    }

    pub fn hotspotPortalStatusRoute(
        self: RuntimeServer,
        hotspot: system_mod.HotspotActivator,
        portal: system_mod.WifiHotspotPortalBoundary,
        startup_state: system_mod.SystemStartupState,
        startup_scene: []const u8,
    ) HotspotPortalStatusRoute {
        return .{ .server = self, .hotspot = hotspot, .portal = portal, .startup_state = startup_state, .startup_scene = startup_scene };
    }

    pub fn deviceSummaryRoute(
        self: RuntimeServer,
        device_utils: system_mod.DeviceUtilities,
        startup_scene: []const u8,
        startup_state: system_mod.SystemStartupState,
    ) DeviceSummaryRoute {
        return .{ .server = self, .device_utils = device_utils, .startup_scene = startup_scene, .startup_state = startup_state };
    }
};

pub const HealthRoute = struct {
    server: RuntimeServer,
    snapshot: health_mod.HealthSnapshot,
    probe_mode: config_mod.NetworkProbeMode,
    probe_outcome: ?network_probe_mod.ProbeOutcome,

    pub fn renderJson(self: HealthRoute, buffer: []u8) ![]const u8 {
        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();
        try writer.print(
            "{\"status\":\"{s}\",\"startupState\":\"{s}\",\"serverStarted\":{},\"networkRequired\":{},\"networkOk\":{s},\"schedulerReady\":{},\"runnerReady\":{},\"networkProbe\":{\"mode\":\"{s}\",\"outcome\":\"{s}\"},\"host\":\"{s}\",\"port\":{}}",
            .{
                statusLabel(self.snapshot.status),
                health_mod.startupStateLabel(self.snapshot.startup_state),
                self.snapshot.server_started,
                self.snapshot.network_required,
                networkLabel(self.snapshot.network_ok),
                self.snapshot.scheduler_ready,
                self.snapshot.runner_ready,
                config_mod.probeModeLabel(self.probe_mode),
                probeOutcomeLabel(self.probe_outcome),
                self.server.config.frame_host,
                self.server.config.frame_port,
            },
        );

        return stream.getWritten();
    }
};

pub const ScenesRoute = struct {
    server: RuntimeServer,
    registry: scenes_mod.SceneRegistry,

    pub fn renderJson(self: ScenesRoute, buffer: []u8) ![]const u8 {
        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();
        const scene_ids = self.registry.listSceneIds();

        try writer.print("{\"host\":\"{s}\",\"port\":{},\"scenes\":[", .{ self.server.config.frame_host, self.server.config.frame_port });

        var emitted: usize = 0;
        for (scene_ids) |scene_id| {
            const manifest = self.registry.loadManifest(scene_id) orelse continue;
            if (emitted > 0) try writer.writeAll(",");
            try writer.print("{\"id\":\"{s}\",\"appId\":\"{s}\",\"entrypoint\":\"{s}\",", .{ manifest.scene_id, manifest.app.id, manifest.entrypoint });

            const lifecycle = try apps_mod.appLifecycleSummaryForScene(scene_id, .{ .allocator = std.heap.page_allocator });
            if (lifecycle) |summary| {
                try writer.print("\"appLifecycle\":{\"appId\":\"{s}\",\"lifecycle\":\"{s}\",\"frameRateHz\":{}},", .{ summary.app_id, summary.lifecycle, summary.frame_rate_hz });
            } else {
                try writer.writeAll("\"appLifecycle\":null,");
            }

            try writer.print("\"settingsAvailable\":{}", .{apps_mod.sceneSettingsAvailableForScene(scene_id)});
            try writer.writeAll("}");
            emitted += 1;
        }

        try writer.writeAll("]}");
        return stream.getWritten();
    }
};

pub const SceneByIdRoute = struct {
    server: RuntimeServer,
    result: scenes_mod.SceneManifestResult,
    app_lifecycle: ?apps_mod.AppStartupSummary,

    pub fn renderJson(self: SceneByIdRoute, buffer: []u8) ![]const u8 {
        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();

        if (self.result.manifest) |manifest| {
            if (self.app_lifecycle) |summary| {
                try writer.print(
                    "{\"host\":\"{s}\",\"port\":{},\"requestedId\":\"{s}\",\"found\":true,\"scene\":{\"id\":\"{s}\",\"appId\":\"{s}\",\"entrypoint\":\"{s}\"},\"appLifecycle\":{\"appId\":\"{s}\",\"lifecycle\":\"{s}\",\"frameRateHz\":{}}}",
                    .{ self.server.config.frame_host, self.server.config.frame_port, self.result.requested_scene_id, manifest.scene_id, manifest.app.id, manifest.entrypoint, summary.app_id, summary.lifecycle, summary.frame_rate_hz },
                );
            } else {
                try writer.print(
                    "{\"host\":\"{s}\",\"port\":{},\"requestedId\":\"{s}\",\"found\":true,\"scene\":{\"id\":\"{s}\",\"appId\":\"{s}\",\"entrypoint\":\"{s}\"},\"appLifecycle\":null}",
                    .{ self.server.config.frame_host, self.server.config.frame_port, self.result.requested_scene_id, manifest.scene_id, manifest.app.id, manifest.entrypoint },
                );
            }
        } else {
            try writer.print(
                "{\"host\":\"{s}\",\"port\":{},\"requestedId\":\"{s}\",\"found\":false,\"error\":{\"code\":\"scene_not_found\",\"message\":\"Unknown scene id\"}}",
                .{ self.server.config.frame_host, self.server.config.frame_port, self.result.requested_scene_id },
            );
        }

        return stream.getWritten();
    }
};

pub const SceneSettingsByIdRoute = struct {
    server: RuntimeServer,
    result: scenes_mod.SceneManifestResult,

    pub fn renderJson(self: SceneSettingsByIdRoute, buffer: []u8) ![]const u8 {
        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();

        if (self.result.manifest) |manifest| {
            var settings_buf: [256]u8 = undefined;
            const settings = try apps_mod.sceneSettingsPayloadForScene(manifest.scene_id, &settings_buf);

            try writer.print(
                "{\"host\":\"{s}\",\"port\":{},\"requestedId\":\"{s}\",\"found\":true,\"scene\":{\"id\":\"{s}\",\"appId\":\"{s}\"},",
                .{ self.server.config.frame_host, self.server.config.frame_port, self.result.requested_scene_id, manifest.scene_id, manifest.app.id },
            );

            if (settings) |payload| {
                try writer.print("\"settings\":{s}", .{payload});
            } else {
                try writer.writeAll("\"settings\":null");
            }

            try writer.writeAll("}");
        } else {
            try writer.print(
                "{\"host\":\"{s}\",\"port\":{},\"requestedId\":\"{s}\",\"found\":false,\"error\":{\"code\":\"scene_not_found\",\"message\":\"Unknown scene id\"}}",
                .{ self.server.config.frame_host, self.server.config.frame_port, self.result.requested_scene_id },
            );
        }

        return stream.getWritten();
    }
};

pub const HotspotPortalStatusRoute = struct {
    server: RuntimeServer,
    hotspot: system_mod.HotspotActivator,
    portal: system_mod.WifiHotspotPortalBoundary,
    startup_state: system_mod.SystemStartupState,
    startup_scene: []const u8,

    pub fn renderJson(self: HotspotPortalStatusRoute, buffer: []u8) ![]const u8 {
        var portal_url_buf: [128]u8 = undefined;
        const portal_url = try self.portal.captivePortalUrl(&portal_url_buf);

        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();
        try writer.print(
            "{\"host\":\"{s}\",\"port\":{},\"startupScene\":\"{s}\",\"startupState\":\"{s}\",\"hotspotActive\":{},\"portal\":{\"url\":\"{s}\"}}",
            .{ self.server.config.frame_host, self.server.config.frame_port, self.startup_scene, system_mod.startupStateLabel(self.startup_state), self.hotspot.shouldActivateHotspot(), portal_url },
        );

        return stream.getWritten();
    }
};

pub const DeviceSummaryRoute = struct {
    server: RuntimeServer,
    device_utils: system_mod.DeviceUtilities,
    startup_scene: []const u8,
    startup_state: system_mod.SystemStartupState,

    pub fn renderJson(self: DeviceSummaryRoute, buffer: []u8) ![]const u8 {
        var summary_buf: [128]u8 = undefined;
        const summary = try self.device_utils.summary(&summary_buf);

        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();
        try writer.print(
            "{\"host\":\"{s}\",\"port\":{},\"startupScene\":\"{s}\",\"startupState\":\"{s}\",\"device\":{\"name\":\"{s}\",\"kind\":\"{s}\",\"resolution\":{\"width\":{},\"height\":{}},\"rotationDeg\":{},\"summary\":\"{s}\"}}",
            .{ self.server.config.frame_host, self.server.config.frame_port, self.startup_scene, system_mod.startupStateLabel(self.startup_state), self.device_utils.info.name, self.device_utils.info.kind, self.device_utils.info.resolution.width, self.device_utils.info.resolution.height, self.device_utils.info.rotation_deg, summary },
        );

        return stream.getWritten();
    }
};

fn statusLabel(status: health_mod.HealthSnapshot.Status) []const u8 {
    return switch (status) {
        .ok => "ok",
        .degraded => "degraded",
    };
}

fn probeOutcomeLabel(probe_outcome: ?network_probe_mod.ProbeOutcome) []const u8 {
    return if (probe_outcome) |outcome| network_probe_mod.outcomeLabel(outcome) else "unknown";
}

fn networkLabel(network_ok: ?bool) []const u8 {
    return if (network_ok) |is_ok| if (is_ok) "true" else "false" else "null";
}

test "health route renders snapshot JSON payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const route = server.healthRoute(.{ .status = .ok, .startup_state = .ready, .server_started = true, .network_required = true, .network_ok = true, .scheduler_ready = true, .runner_ready = true }, .force_ok, .ok);

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"status\":\"ok\",\"startupState\":\"ready\",\"serverStarted\":true,\"networkRequired\":true,\"networkOk\":true,\"schedulerReady\":true,\"runnerReady\":true,\"networkProbe\":{\"mode\":\"force-ok\",\"outcome\":\"ok\"},\"host\":\"0.0.0.0\",\"port\":7777}",
        payload,
    );
}

test "health route renders degraded payload when network probe fails" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const route = server.healthRoute(.{ .status = .degraded, .startup_state = .degraded_network, .server_started = true, .network_required = true, .network_ok = false, .scheduler_ready = true, .runner_ready = true }, .force_failed, .failed);

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"status\":\"degraded\",\"startupState\":\"degraded-network\",\"serverStarted\":true,\"networkRequired\":true,\"networkOk\":false,\"schedulerReady\":true,\"runnerReady\":true,\"networkProbe\":{\"mode\":\"force-failed\",\"outcome\":\"failed\"},\"host\":\"0.0.0.0\",\"port\":7777}",
        payload,
    );
}

test "health route renders unknown probe outcome when network checks are disabled" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = false, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = false, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const route = server.healthRoute(.{ .status = .ok, .startup_state = .ready, .server_started = true, .network_required = false, .network_ok = null, .scheduler_ready = true, .runner_ready = true }, .auto, null);

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"status\":\"ok\",\"startupState\":\"ready\",\"serverStarted\":true,\"networkRequired\":false,\"networkOk\":null,\"schedulerReady\":true,\"runnerReady\":true,\"networkProbe\":{\"mode\":\"auto\",\"outcome\":\"unknown\"},\"host\":\"0.0.0.0\",\"port\":7777}",
        payload,
    );
}

test "scenes route renders scene discovery payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const config: config_mod.RuntimeConfig = .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" };

    const server = RuntimeServer.init(logger, config);
    const registry = scenes_mod.SceneRegistry.init(logger, "clock");

    const route = server.scenesRoute(registry);
    var buf: [1536]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"scenes\":[{\"id\":\"clock\",\"appId\":\"app.clock\",\"entrypoint\":\"apps/clock/main\",\"appLifecycle\":{\"appId\":\"app.clock\",\"lifecycle\":\"clock\",\"frameRateHz\":1},\"settingsAvailable\":false},{\"id\":\"weather\",\"appId\":\"app.weather\",\"entrypoint\":\"apps/weather/main\",\"appLifecycle\":{\"appId\":\"app.weather\",\"lifecycle\":\"weather\",\"frameRateHz\":30},\"settingsAvailable\":true},{\"id\":\"calendar\",\"appId\":\"app.calendar\",\"entrypoint\":\"apps/calendar/main\",\"appLifecycle\":{\"appId\":\"app.calendar\",\"lifecycle\":\"calendar\",\"frameRateHz\":12},\"settingsAvailable\":true},{\"id\":\"news\",\"appId\":\"app.news\",\"entrypoint\":\"apps/news/main\",\"appLifecycle\":{\"appId\":\"app.news\",\"lifecycle\":\"news\",\"frameRateHz\":10},\"settingsAvailable\":true},{\"id\":\"quotes\",\"appId\":\"app.quotes\",\"entrypoint\":\"apps/quotes/main\",\"appLifecycle\":{\"appId\":\"app.quotes\",\"lifecycle\":\"quotes\",\"frameRateHz\":8},\"settingsAvailable\":true},{\"id\":\"transit\",\"appId\":\"app.transit\",\"entrypoint\":\"apps/transit/main\",\"appLifecycle\":{\"appId\":\"app.transit\",\"lifecycle\":\"transit\",\"frameRateHz\":2},\"settingsAvailable\":true},{\"id\":\"stocks\",\"appId\":\"app.stocks\",\"entrypoint\":\"apps/stocks/main\",\"appLifecycle\":{\"appId\":\"app.stocks\",\"lifecycle\":\"stocks\",\"frameRateHz\":4},\"settingsAvailable\":true}]}",
        payload,
    );
}

test "scene by id route renders successful scene payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = try server.sceneByIdRoute(registry, "weather");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"weather\",\"found\":true,\"scene\":{\"id\":\"weather\",\"appId\":\"app.weather\",\"entrypoint\":\"apps/weather/main\"},\"appLifecycle\":{\"appId\":\"app.weather\",\"lifecycle\":\"weather\",\"frameRateHz\":30}}",
        payload,
    );
}



test "scene by id route renders calendar lifecycle metadata" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = try server.sceneByIdRoute(registry, "calendar");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"calendar\",\"found\":true,\"scene\":{\"id\":\"calendar\",\"appId\":\"app.calendar\",\"entrypoint\":\"apps/calendar/main\"},\"appLifecycle\":{\"appId\":\"app.calendar\",\"lifecycle\":\"calendar\",\"frameRateHz\":12}}",
        payload,
    );
}


test "scene by id route renders news lifecycle metadata" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = try server.sceneByIdRoute(registry, "news");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"news\",\"found\":true,\"scene\":{\"id\":\"news\",\"appId\":\"app.news\",\"entrypoint\":\"apps/news/main\"},\"appLifecycle\":{\"appId\":\"app.news\",\"lifecycle\":\"news\",\"frameRateHz\":10}}",
        payload,
    );
}


test "scene by id route renders quotes lifecycle metadata" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = try server.sceneByIdRoute(registry, "quotes");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"quotes\",\"found\":true,\"scene\":{\"id\":\"quotes\",\"appId\":\"app.quotes\",\"entrypoint\":\"apps/quotes/main\"},\"appLifecycle\":{\"appId\":\"app.quotes\",\"lifecycle\":\"quotes\",\"frameRateHz\":8}}",
        payload,
    );
}

test "scene by id route renders transit lifecycle metadata" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = try server.sceneByIdRoute(registry, "transit");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"transit\",\"found\":true,\"scene\":{\"id\":\"transit\",\"appId\":\"app.transit\",\"entrypoint\":\"apps/transit/main\"},\"appLifecycle\":{\"appId\":\"app.transit\",\"lifecycle\":\"transit\",\"frameRateHz\":2}}",
        payload,
    );
}

test "scene by id route renders error payload for unknown scene id" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = try server.sceneByIdRoute(registry, "unknown-scene");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"unknown-scene\",\"found\":false,\"error\":{\"code\":\"scene_not_found\",\"message\":\"Unknown scene id\"}}",
        payload,
    );
}

test "scene settings by id route renders calendar settings payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = server.sceneSettingsByIdRoute(registry, "calendar");

    var buf: [384]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"calendar\",\"found\":true,\"scene\":{\"id\":\"calendar\",\"appId\":\"app.calendar\"},\"settings\":{\"timezone\":\"UTC\",\"weekStartsOnMonday\":true,\"maxVisibleEvents\":5}}",
        payload,
    );
}

test "scene settings by id route renders weather settings payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = server.sceneSettingsByIdRoute(registry, "weather");

    var buf: [384]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"weather\",\"found\":true,\"scene\":{\"id\":\"weather\",\"appId\":\"app.weather\"},\"settings\":{\"location\":\"San Francisco, CA\",\"units\":\"metric\",\"refreshIntervalMin\":15}}",
        payload,
    );
}

test "scene settings by id route renders news settings payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = server.sceneSettingsByIdRoute(registry, "news");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"news\",\"found\":true,\"scene\":{\"id\":\"news\",\"appId\":\"app.news\"},\"settings\":{\"feed\":\"frameos\",\"maxHeadlines\":6,\"refreshIntervalMin\":20}}",
        payload,
    );
}


test "scene settings by id route renders quotes settings payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = server.sceneSettingsByIdRoute(registry, "quotes");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"quotes\",\"found\":true,\"scene\":{\"id\":\"quotes\",\"appId\":\"app.quotes\"},\"settings\":{\"feed\":\"zen\",\"maxQuotes\":5,\"refreshIntervalMin\":30}}",
        payload,
    );
}

test "scene settings by id route renders transit settings payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = server.sceneSettingsByIdRoute(registry, "transit");

    var buf: [384]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"transit\",\"found\":true,\"scene\":{\"id\":\"transit\",\"appId\":\"app.transit\"},\"settings\":{\"stopId\":\"sf-muni-judah-outbound\",\"direction\":\"outbound\",\"refreshIntervalS\":45}}",
        payload,
    );
}

test "scene by id route renders stocks lifecycle metadata" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = try server.sceneByIdRoute(registry, "stocks");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"stocks\",\"found\":true,\"scene\":{\"id\":\"stocks\",\"appId\":\"app.stocks\",\"entrypoint\":\"apps/stocks/main\"},\"appLifecycle\":{\"appId\":\"app.stocks\",\"lifecycle\":\"stocks\",\"frameRateHz\":4}}",
        payload,
    );
}

test "scene settings by id route renders stocks settings payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = server.sceneSettingsByIdRoute(registry, "stocks");

    var buf: [384]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"stocks\",\"found\":true,\"scene\":{\"id\":\"stocks\",\"appId\":\"app.stocks\"},\"settings\":{\"symbol\":\"NVDA\",\"exchange\":\"NASDAQ\",\"range\":\"1D\",\"refreshIntervalS\":30}}",
        payload,
    );
}

test "scene settings by id route renders unknown-scene error payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "127.0.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 60, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const server = RuntimeServer.init(logger, .{ .frame_host = "0.0.0.0", .frame_port = 7777, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const route = server.sceneSettingsByIdRoute(registry, "unknown-scene");

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"requestedId\":\"unknown-scene\",\"found\":false,\"error\":{\"code\":\"scene_not_found\",\"message\":\"Unknown scene id\"}}",
        payload,
    );
}

test "server route registration includes scene settings route" {
    const testing = std.testing;

    const routes = RuntimeServer.registeredRoutes();
    try testing.expectEqual(@as(usize, 6), routes.len);
    try testing.expectEqualStrings("/health", routes[0]);
    try testing.expectEqualStrings("/scenes", routes[1]);
    try testing.expectEqualStrings("/scenes/:id", routes[2]);
    try testing.expectEqualStrings("/scenes/:id/settings", routes[3]);
    try testing.expectEqualStrings("/system/hotspot", routes[4]);
    try testing.expectEqualStrings("/system/device", routes[5]);
}

test "hotspot status route exposes wifi-hotspot startup scene context" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "10.42.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 30, .network_check = false, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const config: config_mod.RuntimeConfig = .{ .frame_host = "10.42.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 30, .network_check = false, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" };

    const server = RuntimeServer.init(logger, config);
    const startup_scene = system_mod.defaultStartupScene(config);
    const hotspot = system_mod.HotspotActivator.init(logger, startup_scene, .degraded_network);
    const portal = system_mod.WifiHotspotPortalBoundary.init(logger, .{ .ssid = "FrameOS Setup", .password = "frameos", .frame_host = config.frame_host, .frame_port = config.frame_port });

    const route = server.hotspotPortalStatusRoute(hotspot, portal, .degraded_network, "wifi-hotspot");
    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"10.42.0.1\",\"port\":8787,\"startupScene\":\"wifi-hotspot\",\"startupState\":\"degraded-network\",\"hotspotActive\":true,\"portal\":{\"url\":\"http://10.42.0.1:8787/\"}}",
        payload,
    );
}

test "hotspot status route exposes index startup scene context" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "10.42.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const config: config_mod.RuntimeConfig = .{ .frame_host = "10.42.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 30, .network_check = true, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" };

    const server = RuntimeServer.init(logger, config);
    const startup_scene = system_mod.defaultStartupScene(config);
    const hotspot = system_mod.HotspotActivator.init(logger, startup_scene, .ready);
    const portal = system_mod.WifiHotspotPortalBoundary.init(logger, .{ .ssid = "FrameOS Setup", .password = "frameos", .frame_host = config.frame_host, .frame_port = config.frame_port });

    const route = server.hotspotPortalStatusRoute(hotspot, portal, .ready, "index");
    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"10.42.0.1\",\"port\":8787,\"startupScene\":\"index\",\"startupState\":\"ready\",\"hotspotActive\":false,\"portal\":{\"url\":\"http://10.42.0.1:8787/\"}}",
        payload,
    );
}

test "device summary route renders device payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{ .frame_host = "10.42.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 30, .network_check = false, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" });

    const config: config_mod.RuntimeConfig = .{ .frame_host = "10.42.0.1", .frame_port = 8787, .debug = false, .metrics_interval_s = 30, .network_check = false, .network_probe_mode = .auto, .device = "simulator", .startup_scene = "clock" };

    const server = RuntimeServer.init(logger, config);
    const device_utils = system_mod.DeviceUtilities.init(logger, .{ .name = "FrameOS Device", .kind = config.device, .resolution = .{ .width = 800, .height = 480 }, .rotation_deg = 0 });

    const route = server.deviceSummaryRoute(device_utils, "clock", .ready);
    var buf: [320]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"10.42.0.1\",\"port\":8787,\"startupScene\":\"clock\",\"startupState\":\"ready\",\"device\":{\"name\":\"FrameOS Device\",\"kind\":\"simulator\",\"resolution\":{\"width\":800,\"height\":480},\"rotationDeg\":0,\"summary\":\"FrameOS Device (simulator) 800x480 @ 0°\"}}",
        payload,
    );
}
