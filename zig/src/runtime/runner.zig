const apps_mod = @import("../apps/mod.zig");
const logger_mod = @import("logger.zig");
const scenes_mod = @import("scenes.zig");

pub const RuntimeRunner = struct {
    logger: logger_mod.RuntimeLogger,
    device: []const u8,
    scene_registry: scenes_mod.SceneRegistry,

    pub fn init(logger: logger_mod.RuntimeLogger, device: []const u8, scene_registry: scenes_mod.SceneRegistry) RuntimeRunner {
        return .{
            .logger = logger,
            .device = device,
            .scene_registry = scene_registry,
        };
    }

    pub fn startup(self: RuntimeRunner) !void {
        const startup_scene = self.scene_registry.resolveStartupScene();
        const manifest = self.scene_registry.loadManifest(startup_scene);

        const app_id = if (manifest) |loaded| loaded.app.id else "unknown";
        const app_entrypoint = if (manifest) |loaded| loaded.entrypoint else "unknown";

        try self.logger.info(
            "{\"event\":\"runner.start\",\"status\":\"stub\",\"device\":\"{s}\",\"startupScene\":\"{s}\",\"appId\":\"{s}\",\"appEntrypoint\":\"{s}\",\"boundary\":\"runtime->apps\"}",
            .{ self.device, startup_scene, app_id, app_entrypoint },
        );
    }
};

test "runner resolves startup scene manifest through registry" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "calendar",
    });

    const registry = scenes_mod.SceneRegistry.init(logger, "calendar");
    const manifest = registry.loadManifest(registry.resolveStartupScene()) orelse return error.TestUnexpectedResult;

    try testing.expectEqualStrings("app.calendar", manifest.app.id);
    try testing.expectEqualStrings("apps/calendar/main", manifest.entrypoint);
}

test "apps module returns no manifest for unknown scene" {
    const testing = @import("std").testing;

    try testing.expectEqual(@as(?apps_mod.SceneManifest, null), apps_mod.findSceneManifest("unknown-scene"));
}
