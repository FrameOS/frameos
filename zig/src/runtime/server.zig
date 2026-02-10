const std = @import("std");
const config_mod = @import("config.zig");
const health_mod = @import("health.zig");
const logger_mod = @import("logger.zig");
const scenes_mod = @import("scenes.zig");

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

        try self.logger.info(
            "{\"event\":\"server.route\",\"route\":\"/health\",\"status\":\"stub\",\"method\":\"GET\"}",
            .{},
        );

        try self.logger.info(
            "{\"event\":\"server.route\",\"route\":\"/scenes\",\"status\":\"stub\",\"method\":\"GET\"}",
            .{},
        );
    }

    pub fn healthRoute(self: RuntimeServer, snapshot: health_mod.HealthSnapshot) HealthRoute {
        return .{ .server = self, .snapshot = snapshot };
    }

    pub fn scenesRoute(self: RuntimeServer, registry: scenes_mod.SceneRegistry) ScenesRoute {
        return .{ .server = self, .registry = registry };
    }
};

pub const HealthRoute = struct {
    server: RuntimeServer,
    snapshot: health_mod.HealthSnapshot,

    pub fn renderJson(self: HealthRoute, buffer: []u8) ![]const u8 {
        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();
        try writer.print(
            "{\"status\":\"{s}\",\"serverStarted\":{},\"networkRequired\":{},\"networkOk\":{s},\"schedulerReady\":{},\"runnerReady\":{},\"host\":\"{s}\",\"port\":{}}",
            .{
                statusLabel(self.snapshot.status),
                self.snapshot.server_started,
                self.snapshot.network_required,
                networkLabel(self.snapshot.network_ok),
                self.snapshot.scheduler_ready,
                self.snapshot.runner_ready,
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

        for (scene_ids, 0..) |scene_id, idx| {
            const manifest = self.registry.loadManifest(scene_id) orelse continue;
            if (idx > 0) {
                try writer.writeAll(",");
            }
            try writer.print(
                "{\"id\":\"{s}\",\"appId\":\"{s}\",\"entrypoint\":\"{s}\"}",
                .{ manifest.scene_id, manifest.app.id, manifest.entrypoint },
            );
        }

        try writer.writeAll("]}");
        return stream.getWritten();
    }
};

fn statusLabel(status: health_mod.HealthSnapshot.Status) []const u8 {
    return switch (status) {
        .ok => "ok",
        .degraded => "degraded",
    };
}

fn networkLabel(network_ok: ?bool) []const u8 {
    return if (network_ok) |is_ok|
        if (is_ok) "true" else "false"
    else
        "null";
}

test "health route renders snapshot JSON payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const server = RuntimeServer.init(logger, .{
        .frame_host = "0.0.0.0",
        .frame_port = 7777,
        .debug = false,
        .metrics_interval_s = 30,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const route = server.healthRoute(.{
        .status = .ok,
        .server_started = true,
        .network_required = true,
        .network_ok = true,
        .scheduler_ready = true,
        .runner_ready = true,
    });

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"status\":\"ok\",\"serverStarted\":true,\"networkRequired\":true,\"networkOk\":true,\"schedulerReady\":true,\"runnerReady\":true,\"host\":\"0.0.0.0\",\"port\":7777}",
        payload,
    );
}

test "scenes route renders scene discovery payload" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const config: config_mod.RuntimeConfig = .{
        .frame_host = "0.0.0.0",
        .frame_port = 7777,
        .debug = false,
        .metrics_interval_s = 30,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "clock",
    };

    const server = RuntimeServer.init(logger, config);
    const registry = scenes_mod.SceneRegistry.init(logger, "clock");

    const route = server.scenesRoute(registry);
    var buf: [512]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"host\":\"0.0.0.0\",\"port\":7777,\"scenes\":[{\"id\":\"clock\",\"appId\":\"app.clock\",\"entrypoint\":\"apps/clock/main\"},{\"id\":\"weather\",\"appId\":\"app.weather\",\"entrypoint\":\"apps/weather/main\"},{\"id\":\"calendar\",\"appId\":\"app.calendar\",\"entrypoint\":\"apps/calendar/main\"}]}",
        payload,
    );
}
