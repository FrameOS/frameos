const logger_mod = @import("../runtime/logger.zig");
const startup_scene_mod = @import("startup_scene.zig");

pub const HotspotActivator = struct {
    logger: logger_mod.RuntimeLogger,
    startup_scene: startup_scene_mod.SystemStartupScene,
    startup_state: startup_scene_mod.SystemStartupState,

    pub fn init(logger: logger_mod.RuntimeLogger, startup_scene: startup_scene_mod.SystemStartupScene, startup_state: startup_scene_mod.SystemStartupState) HotspotActivator {
        return .{
            .logger = logger,
            .startup_scene = startup_scene,
            .startup_state = startup_state,
        };
    }

    pub fn shouldActivateHotspot(self: HotspotActivator) bool {
        return self.startup_scene == .wifi_hotspot or self.startup_state == .degraded_network;
    }

    pub fn startup(self: HotspotActivator) !void {
        try self.logger.info(
            "{\"event\":\"system.hotspot.startup\",\"status\":\"stub\",\"activate\":{},\"startupScene\":\"{s}\",\"startupState\":\"{s}\"}",
            .{ self.shouldActivateHotspot(), startup_scene_mod.startupSceneLabel(self.startup_scene), startup_scene_mod.startupStateLabel(self.startup_state) },
        );
    }
};

test "hotspot activator enables hotspot for hotspot startup scene" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger{ .debug_enabled = false };
    const activator = HotspotActivator.init(logger, .wifi_hotspot, .ready);

    try testing.expect(activator.shouldActivateHotspot());
}

test "hotspot activator keeps hotspot off for ready index startup scene" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger{ .debug_enabled = false };
    const activator = HotspotActivator.init(logger, .index, .ready);

    try testing.expect(!activator.shouldActivateHotspot());
}

test "hotspot activator enables hotspot for degraded network startup state" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger{ .debug_enabled = false };
    const activator = HotspotActivator.init(logger, .index, .degraded_network);

    try testing.expect(activator.shouldActivateHotspot());
}
