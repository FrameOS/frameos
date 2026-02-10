const std = @import("std");
const config_mod = @import("config.zig");
const logger_mod = @import("logger.zig");

pub const ProbeOutcome = enum {
    skipped,
    ok,
    failed,
};

pub const ProbeTarget = struct {
    host: []const u8,
    port: u16,
};

pub const RuntimeNetworkProbe = struct {
    logger: logger_mod.RuntimeLogger,
    enabled: bool,
    mode: config_mod.NetworkProbeMode,

    pub fn init(logger: logger_mod.RuntimeLogger, enabled: bool, mode: config_mod.NetworkProbeMode) RuntimeNetworkProbe {
        return .{
            .logger = logger,
            .enabled = enabled,
            .mode = mode,
        };
    }

    pub fn startup(self: RuntimeNetworkProbe) !void {
        try self.logger.info(
            "{\"event\":\"network_probe.start\",\"status\":\"stub\",\"enabled\":{},\"mode\":\"{s}\"}",
            .{ self.enabled, config_mod.probeModeLabel(self.mode) },
        );
    }

    pub fn probe(self: RuntimeNetworkProbe, target: ProbeTarget) !ProbeOutcome {
        if (!self.enabled) {
            try self.logger.info(
                "{\"event\":\"network_probe.result\",\"host\":\"{s}\",\"port\":{},\"outcome\":\"skipped\",\"mode\":\"{s}\"}",
                .{ target.host, target.port, config_mod.probeModeLabel(self.mode) },
            );
            return .skipped;
        }

        const outcome = switch (self.mode) {
            .force_ok => ProbeOutcome.ok,
            .force_failed => ProbeOutcome.failed,
            .auto => if (std.mem.eql(u8, target.host, "0.0.0.0") or std.mem.eql(u8, target.host, "offline")) .failed else .ok,
        };

        try self.logger.info(
            "{\"event\":\"network_probe.result\",\"host\":\"{s}\",\"port\":{},\"outcome\":\"{s}\",\"mode\":\"{s}\"}",
            .{ target.host, target.port, outcomeLabel(outcome), config_mod.probeModeLabel(self.mode) },
        );

        return outcome;
    }
};

pub fn outcomeLabel(outcome: ProbeOutcome) []const u8 {
    return switch (outcome) {
        .skipped => "skipped",
        .ok => "ok",
        .failed => "failed",
    };
}

test "probe returns skipped when disabled" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 30,
        .network_check = false,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const probe = RuntimeNetworkProbe.init(logger, false, .auto);
    const outcome = try probe.probe(.{ .host = "127.0.0.1", .port = 8787 });

    try testing.expectEqual(ProbeOutcome.skipped, outcome);
}

test "probe returns failed for stubbed offline hosts in auto mode" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 30,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const probe = RuntimeNetworkProbe.init(logger, true, .auto);
    const outcome = try probe.probe(.{ .host = "offline", .port = 8787 });

    try testing.expectEqual(ProbeOutcome.failed, outcome);
}

test "probe mode force-ok returns ok" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 30,
        .network_check = true,
        .network_probe_mode = .force_ok,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const probe = RuntimeNetworkProbe.init(logger, true, .force_ok);
    const outcome = try probe.probe(.{ .host = "offline", .port = 8787 });

    try testing.expectEqual(ProbeOutcome.ok, outcome);
}

test "probe mode force-failed returns failed" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 30,
        .network_check = true,
        .network_probe_mode = .force_failed,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const probe = RuntimeNetworkProbe.init(logger, true, .force_failed);
    const outcome = try probe.probe(.{ .host = "127.0.0.1", .port = 8787 });

    try testing.expectEqual(ProbeOutcome.failed, outcome);
}
