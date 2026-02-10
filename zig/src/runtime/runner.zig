const std = @import("std");
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
        const app_startup = if (try apps_mod.appLifecycleSummaryForScene(startup_scene, .{ .allocator = std.heap.page_allocator })) |summary|
            summary
        else
            apps_mod.AppStartupSummary{ .app_id = app_id, .lifecycle = "missing", .frame_rate_hz = 0 };

        try self.logger.info(
            "{\"event\":\"runner.start\",\"status\":\"stub\",\"device\":\"{s}\",\"startupScene\":\"{s}\",\"appId\":\"{s}\",\"appEntrypoint\":\"{s}\",\"appLifecycle\":\"{s}\",\"frameRateHz\":{},\"boundary\":\"runtime->apps\"}",
            .{ self.device, startup_scene, app_startup.app_id, app_entrypoint, app_startup.lifecycle, app_startup.frame_rate_hz },
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
        .network_probe_mode = .auto,
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

test "runner uses clock app lifecycle boundary" {
    const testing = @import("std").testing;

    const boundary = apps_mod.loadAppBoundaryForScene("clock") orelse return error.TestUnexpectedResult;
    const summary = try boundary.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("clock", summary.lifecycle);
    try testing.expectEqual(@as(u8, 1), summary.frame_rate_hz);
}


test "runner falls back to missing lifecycle when manifest exists but no app boundary is registered" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "calendar",
    });

    const registry = scenes_mod.SceneRegistry.init(logger, "calendar");
    const startup_scene = registry.resolveStartupScene();
    try testing.expectEqualStrings("calendar", startup_scene);

    const manifest = registry.loadManifest(startup_scene) orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings("app.calendar", manifest.app.id);

    const summary = try apps_mod.appLifecycleSummaryForScene(startup_scene, .{ .allocator = testing.allocator });
    try testing.expectEqual(@as(?apps_mod.AppStartupSummary, null), summary);

    const fallback = if (summary) |resolved|
        resolved
    else
        apps_mod.AppStartupSummary{ .app_id = manifest.app.id, .lifecycle = "missing", .frame_rate_hz = 0 };

    try testing.expectEqualStrings("app.calendar", fallback.app_id);
    try testing.expectEqualStrings("missing", fallback.lifecycle);
    try testing.expectEqual(@as(u8, 0), fallback.frame_rate_hz);
}
