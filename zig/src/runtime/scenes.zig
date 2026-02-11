const std = @import("std");
const apps_mod = @import("../apps/mod.zig");
const logger_mod = @import("logger.zig");

pub const SceneRegistry = struct {
    logger: logger_mod.RuntimeLogger,
    startup_scene: []const u8,

    const built_in_scenes = [_][]const u8{ "clock", "weather", "calendar", "news", "quotes", "transit", "stocks" };

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

    pub fn listSceneIds(_: SceneRegistry) []const []const u8 {
        return &built_in_scenes;
    }

    pub fn loadManifest(self: SceneRegistry, scene_id: []const u8) ?apps_mod.SceneManifest {
        _ = self;
        return apps_mod.findSceneManifest(scene_id);
    }

    pub fn loadManifestResult(self: SceneRegistry, scene_id: []const u8) SceneManifestResult {
        if (self.loadManifest(scene_id)) |manifest| {
            return .{ .requested_scene_id = scene_id, .manifest = manifest };
        }

        return .{ .requested_scene_id = scene_id, .manifest = null };
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

pub const SceneManifestResult = struct {
    requested_scene_id: []const u8,
    manifest: ?apps_mod.SceneManifest,

    pub fn found(self: SceneManifestResult) bool {
        return self.manifest != null;
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
        .network_probe_mode = .auto,
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
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "custom-scene",
    });

    const registry = SceneRegistry.init(logger, "custom-scene");

    try testing.expectEqualStrings("clock", registry.resolveStartupScene());
}

test "registry lists built-in scene identifiers" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const registry = SceneRegistry.init(logger, "clock");
    const scene_ids = registry.listSceneIds();

    try testing.expectEqual(@as(usize, 7), scene_ids.len);
    try testing.expectEqualStrings("clock", scene_ids[0]);
    try testing.expectEqualStrings("transit", scene_ids[5]);
    try testing.expectEqualStrings("stocks", scene_ids[6]);
}

test "registry loads scene manifest through apps boundary" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const registry = SceneRegistry.init(logger, "clock");

    const manifest = registry.loadManifest("weather") orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings("weather", manifest.scene_id);
    try testing.expectEqualStrings("app.weather", manifest.app.id);
}

test "registry returns manifest result errors for unknown scenes" {
    const testing = std.testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const registry = SceneRegistry.init(logger, "clock");
    const result = registry.loadManifestResult("unknown-scene");

    try testing.expectEqualStrings("unknown-scene", result.requested_scene_id);
    try testing.expect(!result.found());
    try testing.expectEqual(@as(?apps_mod.SceneManifest, null), result.manifest);
}
