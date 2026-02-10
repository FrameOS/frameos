const config_mod = @import("../runtime/config.zig");
const logger_mod = @import("../runtime/logger.zig");
const device_utils_mod = @import("device_utils.zig");
const hotspot_mod = @import("hotspot.zig");
const portal_mod = @import("portal.zig");
const startup_scene_mod = @import("startup_scene.zig");

pub const WifiHotspotPortalBoundary = portal_mod.WifiHotspotPortalBoundary;
pub const WifiHotspotPortalConfig = portal_mod.WifiHotspotPortalConfig;

pub const DeviceUtilities = device_utils_mod.DeviceUtilities;
pub const DeviceInfo = device_utils_mod.DeviceInfo;

pub const HotspotActivator = hotspot_mod.HotspotActivator;

pub const SystemStartupScene = startup_scene_mod.SystemStartupScene;
pub const startupSceneLabel = startup_scene_mod.startupSceneLabel;

pub const SystemStartupState = startup_scene_mod.SystemStartupState;
pub const startupStateLabel = startup_scene_mod.startupStateLabel;

pub fn defaultStartupScene(config: config_mod.RuntimeConfig) SystemStartupScene {
    if (config.network_check) {
        return .index;
    }

    return .wifi_hotspot;
}

pub fn startupStateFromConfig(config: config_mod.RuntimeConfig) SystemStartupState {
    if (config.network_check) {
        return .booting;
    }

    return .degraded_network;
}

pub const SystemServices = struct {
    portal: WifiHotspotPortalBoundary,
    device_utils: DeviceUtilities,
    hotspot: HotspotActivator,

    pub fn init(logger: logger_mod.RuntimeLogger, frame_host: []const u8, frame_port: u16, device_kind: []const u8, startup_scene: SystemStartupScene, startup_state: SystemStartupState) SystemServices {
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
            .hotspot = HotspotActivator.init(logger, startup_scene, startup_state),
        };
    }

    pub fn startup(self: SystemServices) !void {
        try self.hotspot.startup();
        try self.portal.startup();
        try self.device_utils.startup();
    }
};

test "default system startup scene is index when network check enabled" {
    const testing = @import("std").testing;

    const scene = defaultStartupScene(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    try testing.expectEqual(SystemStartupScene.index, scene);
    try testing.expectEqualStrings("index", startupSceneLabel(scene));
}

test "default system startup scene is hotspot when network check disabled" {
    const testing = @import("std").testing;

    const scene = defaultStartupScene(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = false,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    try testing.expectEqual(SystemStartupScene.wifi_hotspot, scene);
    try testing.expectEqualStrings("wifi-hotspot", startupSceneLabel(scene));
}

test "startup state is booting when network check enabled" {
    const testing = @import("std").testing;

    const state = startupStateFromConfig(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    try testing.expectEqual(SystemStartupState.booting, state);
    try testing.expectEqualStrings("booting", startupStateLabel(state));
}

test "startup state is degraded network when network check disabled" {
    const testing = @import("std").testing;

    const state = startupStateFromConfig(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = false,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    try testing.expectEqual(SystemStartupState.degraded_network, state);
    try testing.expectEqualStrings("degraded-network", startupStateLabel(state));
}
