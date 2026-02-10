const std = @import("std");
const logger_mod = @import("../runtime/logger.zig");

pub const WifiHotspotPortalConfig = struct {
    ssid: []const u8,
    password: []const u8,
    frame_host: []const u8,
    frame_port: u16,
};

pub const WifiHotspotPortalBoundary = struct {
    logger: logger_mod.RuntimeLogger,
    config: WifiHotspotPortalConfig,

    pub fn init(logger: logger_mod.RuntimeLogger, config: WifiHotspotPortalConfig) WifiHotspotPortalBoundary {
        return .{
            .logger = logger,
            .config = config,
        };
    }

    pub fn startup(self: WifiHotspotPortalBoundary) !void {
        try self.logger.info(
            "{\"event\":\"system.portal.startup\",\"status\":\"stub\",\"ssid\":\"{s}\",\"frameHost\":\"{s}\",\"framePort\":{}}",
            .{ self.config.ssid, self.config.frame_host, self.config.frame_port },
        );
    }

    pub fn captivePortalUrl(self: WifiHotspotPortalBoundary, buffer: []u8) ![]const u8 {
        return std.fmt.bufPrint(buffer, "http://{s}:{}/", .{ self.config.frame_host, self.config.frame_port });
    }
};

test "portal URL uses configured host and port" {
    const testing = std.testing;
    const logger = logger_mod.RuntimeLogger{ .debug_enabled = false };

    const portal = WifiHotspotPortalBoundary.init(logger, .{
        .ssid = "FrameOS Setup",
        .password = "frameos123",
        .frame_host = "10.42.0.1",
        .frame_port = 8787,
    });

    var url_buffer: [64]u8 = undefined;
    const url = try portal.captivePortalUrl(&url_buffer);
    try testing.expectEqualStrings("http://10.42.0.1:8787/", url);
}
