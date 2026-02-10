const std = @import("std");
const logger_mod = @import("logger.zig");

pub const HealthSnapshot = struct {
    status: Status,
    server_started: bool,
    network_required: bool,
    network_ok: ?bool,

    pub const Status = enum {
        ok,
        degraded,
    };
};

pub const RuntimeHealth = struct {
    logger: logger_mod.RuntimeLogger,
    server_started: bool,
    network_required: bool,
    network_ok: ?bool,

    pub fn init(logger: logger_mod.RuntimeLogger, network_required: bool) RuntimeHealth {
        return .{
            .logger = logger,
            .server_started = false,
            .network_required = network_required,
            .network_ok = null,
        };
    }

    pub fn markServerStarted(self: *RuntimeHealth) void {
        self.server_started = true;
    }

    pub fn recordNetworkProbe(self: *RuntimeHealth, ok: bool) void {
        self.network_ok = ok;
    }

    pub fn startup(self: RuntimeHealth) !void {
        const snapshot = self.snapshot();
        try self.logger.info(
            "{\"event\":\"health.start\",\"status\":\"{s}\",\"serverStarted\":{},\"networkRequired\":{},\"networkOk\":{s}}",
            .{
                statusLabel(snapshot.status),
                snapshot.server_started,
                snapshot.network_required,
                networkLabel(snapshot.network_ok),
            },
        );
    }

    pub fn snapshot(self: RuntimeHealth) HealthSnapshot {
        return .{
            .status = if (self.server_started and (!self.network_required or self.network_ok == true)) .ok else .degraded,
            .server_started = self.server_started,
            .network_required = self.network_required,
            .network_ok = self.network_ok,
        };
    }
};

fn statusLabel(status: HealthSnapshot.Status) []const u8 {
    return switch (status) {
        .ok => "ok",
        .degraded => "degraded",
    };
}

fn networkLabel(network_ok: ?bool) []const u8 {
    return if (network_ok) |is_ok|
        if (is_ok) "true" else "false"
    else
        "unknown";
}

test "snapshot is degraded before server startup" {
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

    const health = RuntimeHealth.init(logger, true);
    const snapshot = health.snapshot();

    try testing.expectEqual(HealthSnapshot.Status.degraded, snapshot.status);
    try testing.expect(!snapshot.server_started);
    try testing.expectEqual(@as(?bool, null), snapshot.network_ok);
}

test "snapshot becomes ok after server started and network probe passes" {
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

    var health = RuntimeHealth.init(logger, true);
    health.markServerStarted();
    health.recordNetworkProbe(true);

    const snapshot = health.snapshot();

    try testing.expectEqual(HealthSnapshot.Status.ok, snapshot.status);
    try testing.expect(snapshot.server_started);
    try testing.expectEqual(@as(?bool, true), snapshot.network_ok);
}

test "snapshot can be ok without network requirement" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = false,
        .device = "simulator",
        .startup_scene = "clock",
    });

    var health = RuntimeHealth.init(logger, false);
    health.markServerStarted();

    const snapshot = health.snapshot();

    try testing.expectEqual(HealthSnapshot.Status.ok, snapshot.status);
    try testing.expectEqual(@as(?bool, null), snapshot.network_ok);
}
