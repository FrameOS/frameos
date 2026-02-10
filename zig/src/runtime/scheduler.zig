const logger_mod = @import("logger.zig");

pub const RuntimeScheduler = struct {
    logger: logger_mod.RuntimeLogger,

    pub fn init(logger: logger_mod.RuntimeLogger) RuntimeScheduler {
        return .{ .logger = logger };
    }

    pub fn startup(self: RuntimeScheduler) !void {
        try self.logger.info(
            "{\"event\":\"scheduler.start\",\"status\":\"stub\",\"kind\":\"startup-sequencer\"}",
            .{},
        );
    }
};
