const logger_mod = @import("logger.zig");

pub const RuntimeMetrics = struct {
    logger: logger_mod.RuntimeLogger,
    interval_s: u16,

    pub fn init(logger: logger_mod.RuntimeLogger, interval_s: u16) RuntimeMetrics {
        return .{ .logger = logger, .interval_s = interval_s };
    }

    pub fn startup(self: RuntimeMetrics) !void {
        try self.logger.info(
            "{\"event\":\"metrics.start\",\"status\":\"stub\",\"intervalSeconds\":{}}",
            .{self.interval_s},
        );
    }
};
