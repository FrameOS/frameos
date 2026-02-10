const logger_mod = @import("logger.zig");

pub const RuntimeRunner = struct {
    logger: logger_mod.RuntimeLogger,
    device: []const u8,

    pub fn init(logger: logger_mod.RuntimeLogger, device: []const u8) RuntimeRunner {
        return .{
            .logger = logger,
            .device = device,
        };
    }

    pub fn startup(self: RuntimeRunner) !void {
        try self.logger.info(
            "{\"event\":\"runner.start\",\"status\":\"stub\",\"device\":\"{s}\",\"boundary\":\"runtime->apps\"}",
            .{self.device},
        );
    }
};
