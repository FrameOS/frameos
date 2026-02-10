const std = @import("std");
const config_mod = @import("config.zig");

pub const RuntimeLogger = struct {
    debug_enabled: bool,

    pub fn init(config: config_mod.RuntimeConfig) RuntimeLogger {
        return .{ .debug_enabled = config.debug };
    }

    pub fn startup(self: RuntimeLogger) !void {
        _ = self;
        const stdout = std.io.getStdOut().writer();
        try stdout.print("{\"event\":\"startup\",\"runtime\":\"zig\"}\n", .{});
    }

    pub fn bootup(self: RuntimeLogger, config: config_mod.RuntimeConfig) !void {
        const stdout = std.io.getStdOut().writer();
        try stdout.print(
            "{\"event\":\"bootup\",\"frameHost\":\"{s}\",\"framePort\":{},\"device\":\"{s}\",\"networkCheck\":{},\"metricsInterval\":{},\"debug\":{}}\n",
            .{
                config.frame_host,
                config.frame_port,
                config.device,
                config.network_check,
                config.metrics_interval_s,
                self.debug_enabled,
            },
        );
    }

    pub fn info(self: RuntimeLogger, comptime fmt: []const u8, args: anytype) !void {
        _ = self;
        const stdout = std.io.getStdOut().writer();
        try stdout.print(fmt, args);
        try stdout.writeByte('\n');
    }
};
