const logger_mod = @import("../runtime/logger.zig");
const portal_mod = @import("portal.zig");
const device_utils_mod = @import("device_utils.zig");

pub const WifiHotspotPortalBoundary = portal_mod.WifiHotspotPortalBoundary;
pub const WifiHotspotPortalConfig = portal_mod.WifiHotspotPortalConfig;

pub const DeviceUtilities = device_utils_mod.DeviceUtilities;
pub const DeviceInfo = device_utils_mod.DeviceInfo;

pub const SystemServices = struct {
    portal: WifiHotspotPortalBoundary,
    device_utils: DeviceUtilities,

    pub fn init(logger: logger_mod.RuntimeLogger, frame_host: []const u8, frame_port: u16, device_kind: []const u8) SystemServices {
        return .{
            .portal = WifiHotspotPortalBoundary.init(logger, .{
                .ssid = "FrameOS Setup",
                .password = "frameos",
                .frame_host = frame_host,
                .frame_port = frame_port,
            }),
            .device_utils = DeviceUtilities.init(logger, .{
                .name = "FrameOS Device",
                .kind = device_kind,
                .resolution = .{ .width = 800, .height = 480 },
                .rotation_deg = 0,
            }),
        };
    }

    pub fn startup(self: SystemServices) !void {
        try self.portal.startup();
        try self.device_utils.startup();
    }
};
