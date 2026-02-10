const std = @import("std");
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

    pub fn init(logger: logger_mod.RuntimeLogger, enabled: bool) RuntimeNetworkProbe {
        return .{
            .logger = logger,
            .enabled = enabled,
        };
    }

    pub fn startup(self: RuntimeNetworkProbe) !void {
        try self.logger.info(
            "{\"event\":\"network_probe.start\",\"status\":\"stub\",\"enabled\":{}}",
            .{self.enabled},
        );
    }

    pub fn probe(self: RuntimeNetworkProbe, target: ProbeTarget) !ProbeOutcome {
        if (!self.enabled) {
            try self.logger.info(
                "{\"event\":\"network_probe.result\",\"host\":\"{s}\",\"port\":{},\"outcome\":\"skipped\"}",
                .{ target.host, target.port },
            );
            return .skipped;
        }

        const simulated_failure = std.mem.eql(u8, target.host, "0.0.0.0") or std.mem.eql(u8, target.host, "offline");
        const outcome: ProbeOutcome = if (simulated_failure) .failed else .ok;

        try self.logger.info(
            "{\"event\":\"network_probe.result\",\"host\":\"{s}\",\"port\":{},\"outcome\":\"{s}\"}",
            .{ target.host, target.port, outcomeLabel(outcome) },
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
        .device = "simulator",
        .startup_scene = "clock",
    });

    const probe = RuntimeNetworkProbe.init(logger, false);
    const outcome = try probe.probe(.{ .host = "127.0.0.1", .port = 8787 });

    try testing.expectEqual(ProbeOutcome.skipped, outcome);
}

test "probe returns failed for stubbed offline hosts" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 30,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const probe = RuntimeNetworkProbe.init(logger, true);
    const outcome = try probe.probe(.{ .host = "offline", .port = 8787 });

    try testing.expectEqual(ProbeOutcome.failed, outcome);
}

