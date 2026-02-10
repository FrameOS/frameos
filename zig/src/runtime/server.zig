const config_mod = @import("config.zig");
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
    }
};
