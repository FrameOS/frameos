const std = @import("std");
const drivers_mod = @import("../drivers/mod.zig");
const logger_mod = @import("logger.zig");

pub const DriverPlatform = struct {
    allocator: std.mem.Allocator,
    logger: logger_mod.RuntimeLogger,
    device: []const u8,

    pub fn init(allocator: std.mem.Allocator, logger: logger_mod.RuntimeLogger, device: []const u8) DriverPlatform {
        return .{
            .allocator = allocator,
            .logger = logger,
            .device = device,
        };
    }

    pub fn initDrivers(self: DriverPlatform) !void {
        const config = drivers_mod.configForDevice(self.device);
        const boundary = drivers_mod.DriverBoundary.init(config);
        const startup = try boundary.startup(.{ .allocator = self.allocator });

        switch (startup) {
            .simulator => |sim| {
                try self.logger.info(
                    "{\"event\":\"drivers.init\",\"status\":\"stub\",\"device\":\"{s}\",\"driverId\":\"{s}\",\"kind\":\"simulator\",\"backend\":\"{s}\",\"refreshHz\":{}}",
                    .{ self.device, config.id, sim.backend, sim.refresh_hz },
                );
            },
            .framebuffer => {
                try self.logger.info(
                    "{\"event\":\"drivers.init\",\"status\":\"stub\",\"device\":\"{s}\",\"driverId\":\"{s}\",\"kind\":\"framebuffer\"}",
                    .{ self.device, config.id },
                );
            },
            .gpio => {
                try self.logger.info(
                    "{\"event\":\"drivers.init\",\"status\":\"stub\",\"device\":\"{s}\",\"driverId\":\"{s}\",\"kind\":\"gpio\"}",
                    .{ self.device, config.id },
                );
            },
            .transport => {
                try self.logger.info(
                    "{\"event\":\"drivers.init\",\"status\":\"stub\",\"device\":\"{s}\",\"driverId\":\"{s}\",\"kind\":\"transport\"}",
                    .{ self.device, config.id },
                );
            },
        }
    }
};
