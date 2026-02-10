const std = @import("std");
const logger_mod = @import("logger.zig");

pub const SceneRegistry = struct {
    logger: logger_mod.RuntimeLogger,
    startup_scene: []const u8,

    const built_in_scenes = [_][]const u8{ "clock", "weather", "calendar" };

    pub fn init(logger: logger_mod.RuntimeLogger, startup_scene: []const u8) SceneRegistry {
        return .{
            .logger = logger,
            .startup_scene = startup_scene,
        };
    }

    pub fn startup(self: SceneRegistry) !void {
        const resolved_scene = self.resolveStartupScene();
        try self.logger.info(
            "{\"event\":\"scenes.registry.start\",\"status\":\"stub\",\"requestedStartupScene\":\"{s}\",\"resolvedStartupScene\":\"{s}\",\"sceneCount\":{}}",
            .{ self.startup_scene, resolved_scene, built_in_scenes.len },
        );
    }

    pub fn resolveStartupScene(self: SceneRegistry) []const u8 {
        if (self.contains(self.startup_scene)) {
            return self.startup_scene;
        }

        return built_in_scenes[0];
    }

    pub fn contains(_: SceneRegistry, scene: []const u8) bool {
        for (built_in_scenes) |registered_scene| {
            if (std.mem.eql(u8, scene, registered_scene)) {
                return true;
            }
        }

        return false;
    }
};

test "registry keeps configured startup scene when present" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "weather",
    });

    const registry = SceneRegistry.init(logger, "weather");

    try testing.expectEqualStrings("weather", registry.resolveStartupScene());
}

test "registry falls back to first built-in scene when startup scene missing" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "custom-scene",
    });

    const registry = SceneRegistry.init(logger, "custom-scene");

    try testing.expectEqualStrings("clock", registry.resolveStartupScene());
}
