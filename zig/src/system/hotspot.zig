const logger_mod = @import("../runtime/logger.zig");
const startup_scene_mod = @import("startup_scene.zig");

pub const HotspotActivator = struct {
    logger: logger_mod.RuntimeLogger,
    startup_scene: startup_scene_mod.SystemStartupScene,

    pub fn init(logger: logger_mod.RuntimeLogger, startup_scene: startup_scene_mod.SystemStartupScene) HotspotActivator {
        return .{
            .logger = logger,
            .startup_scene = startup_scene,
        };
    }

    pub fn shouldActivateHotspot(self: HotspotActivator) bool {
        return self.startup_scene == .wifi_hotspot;
    }

    pub fn startup(self: HotspotActivator) !void {
        try self.logger.info(
            "{\"event\":\"system.hotspot.startup\",\"status\":\"stub\",\"activate\":{},\"startupScene\":\"{s}\"}",
            .{ self.shouldActivateHotspot(), startup_scene_mod.startupSceneLabel(self.startup_scene) },
        );
    }
};

test "hotspot activator enables hotspot for hotspot startup scene" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger{ .debug_enabled = false };
    const activator = HotspotActivator.init(logger, .wifi_hotspot);

    try testing.expect(activator.shouldActivateHotspot());
}

test "hotspot activator keeps hotspot off for index startup scene" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger{ .debug_enabled = false };
    const activator = HotspotActivator.init(logger, .index);

    try testing.expect(!activator.shouldActivateHotspot());
}
