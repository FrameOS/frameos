const std = @import("std");
const logger_mod = @import("logger.zig");

pub const DriverPlatform = struct {
    logger: logger_mod.RuntimeLogger,

    pub fn init(logger: logger_mod.RuntimeLogger) DriverPlatform {
        return .{ .logger = logger };
    }

    pub fn initDrivers(self: DriverPlatform) !void {
        try self.logger.info(
            "{\"event\":\"drivers.init\",\"status\":\"stub\",\"boundary\":\"runtime->drivers\"}",
            .{},
        );
    }
};
