const std = @import("std");
const logger_mod = @import("logger.zig");

pub const RuntimeEventLoop = struct {
    logger: logger_mod.RuntimeLogger,
    tick_interval_ns: u64,

    pub fn init(logger: logger_mod.RuntimeLogger, tick_interval_ns: u64) RuntimeEventLoop {
        return .{ .logger = logger, .tick_interval_ns = tick_interval_ns };
    }

    pub fn run(self: RuntimeEventLoop) !void {
        try self.logger.info(
            "{\"event\":\"eventLoop.start\",\"status\":\"running\",\"kind\":\"no-op-render-loop\"}",
            .{},
        );

        while (true) {
            std.time.sleep(self.tick_interval_ns);
        }
    }
};
