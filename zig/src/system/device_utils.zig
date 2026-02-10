const std = @import("std");
const logger_mod = @import("../runtime/logger.zig");

pub const DeviceInfo = struct {
    name: []const u8,
    kind: []const u8,
    resolution: Resolution,
    rotation_deg: i16,

    pub const Resolution = struct {
        width: u16,
        height: u16,
    };
};

pub const DeviceUtilities = struct {
    logger: logger_mod.RuntimeLogger,
    info: DeviceInfo,

    pub fn init(logger: logger_mod.RuntimeLogger, info: DeviceInfo) DeviceUtilities {
        return .{ .logger = logger, .info = info };
    }

    pub fn startup(self: DeviceUtilities) !void {
        try self.logger.info(
            "{\"event\":\"system.device_utils.startup\",\"status\":\"stub\",\"name\":\"{s}\",\"kind\":\"{s}\",\"width\":{},\"height\":{},\"rotation\":{}}",
            .{
                self.info.name,
                self.info.kind,
                self.info.resolution.width,
                self.info.resolution.height,
                self.info.rotation_deg,
            },
        );
    }

    pub fn summary(self: DeviceUtilities, buffer: []u8) ![]const u8 {
        return std.fmt.bufPrint(
            buffer,
            "{s} ({s}) {}x{} @ {}°",
            .{
                self.info.name,
                self.info.kind,
                self.info.resolution.width,
                self.info.resolution.height,
                self.info.rotation_deg,
            },
        );
    }
};

test "device summary renders expected descriptor" {
    const testing = std.testing;
    const logger = logger_mod.RuntimeLogger{ .debug_enabled = false };

    const device_utils = DeviceUtilities.init(logger, .{
        .name = "Kitchen Frame",
        .kind = "simulator",
        .resolution = .{ .width = 800, .height = 480 },
        .rotation_deg = 90,
    });

    var summary_buffer: [64]u8 = undefined;
    const rendered = try device_utils.summary(&summary_buffer);
    try testing.expectEqualStrings("Kitchen Frame (simulator) 800x480 @ 90°", rendered);
}
