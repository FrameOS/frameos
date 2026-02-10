const std = @import("std");
const config_mod = @import("config.zig");
const health_mod = @import("health.zig");
const logger_mod = @import("logger.zig");

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
    }

    pub fn healthRoute(self: RuntimeServer, snapshot: health_mod.HealthSnapshot) HealthRoute {
        return .{ .server = self, .snapshot = snapshot };
    }
};

pub const HealthRoute = struct {
    server: RuntimeServer,
    snapshot: health_mod.HealthSnapshot,

    pub fn renderJson(self: HealthRoute, buffer: []u8) ![]const u8 {
        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();
        try writer.print(
            "{\"status\":\"{s}\",\"serverStarted\":{},\"networkRequired\":{},\"networkOk\":{s},\"host\":\"{s}\",\"port\":{}}",
            .{
                statusLabel(self.snapshot.status),
                self.snapshot.server_started,
                self.snapshot.network_required,
                networkLabel(self.snapshot.network_ok),
                self.server.config.frame_host,
                self.server.config.frame_port,
            },
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
    });

    var buf: [256]u8 = undefined;
    const payload = try route.renderJson(&buf);

    try testing.expectEqualStrings(
        "{\"status\":\"ok\",\"serverStarted\":true,\"networkRequired\":true,\"networkOk\":true,\"host\":\"0.0.0.0\",\"port\":7777}",
        payload,
    );
}
