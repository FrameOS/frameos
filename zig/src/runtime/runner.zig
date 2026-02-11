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
        var payload_buf: [320]u8 = undefined;
        const payload = try self.renderStartupLogPayload(&payload_buf);
        try self.logger.info("{s}", .{payload});
    }

    pub fn renderStartupLogPayload(self: RuntimeRunner, buffer: []u8) ![]const u8 {
        const startup_scene = self.scene_registry.resolveStartupScene();
        const manifest = self.scene_registry.loadManifest(startup_scene);

        const app_id = if (manifest) |loaded| loaded.app.id else "unknown";
        const app_entrypoint = if (manifest) |loaded| loaded.entrypoint else "unknown";
        const app_startup = if (try apps_mod.appLifecycleSummaryForScene(startup_scene, .{ .allocator = std.heap.page_allocator })) |summary|
            summary
        else
            apps_mod.AppStartupSummary{ .app_id = app_id, .lifecycle = "missing", .frame_rate_hz = 0 };
        const app_settings_status = try appSettingsAvailabilityForScene(startup_scene);

        var stream = std.io.fixedBufferStream(buffer);
        const writer = stream.writer();
        try writer.print(
            "{\"event\":\"runner.start\",\"status\":\"stub\",\"device\":\"{s}\",\"startupScene\":\"{s}\",\"appId\":\"{s}\",\"appEntrypoint\":\"{s}\",\"appLifecycle\":\"{s}\",\"frameRateHz\":{},\"appSettings\":\"{s}\",\"boundary\":\"runtime->apps\"}",
            .{ self.device, startup_scene, app_startup.app_id, app_entrypoint, app_startup.lifecycle, app_startup.frame_rate_hz, app_settings_status },
        );

        return stream.getWritten();
    }
};

pub fn appSettingsAvailabilityForScene(scene_id: []const u8) ![]const u8 {
    var settings_buf: [256]u8 = undefined;
    const settings = try apps_mod.sceneSettingsPayloadForScene(scene_id, &settings_buf);
    return if (settings != null) "present" else "missing";
}

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

test "runner resolves news lifecycle when manifest exists" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "news",
    });

    const registry = scenes_mod.SceneRegistry.init(logger, "news");
    const startup_scene = registry.resolveStartupScene();
    try testing.expectEqualStrings("news", startup_scene);

    const manifest = registry.loadManifest(startup_scene) orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings("app.news", manifest.app.id);

    const summary = try apps_mod.appLifecycleSummaryForScene(startup_scene, .{ .allocator = testing.allocator });
    try testing.expect(summary != null);

    const resolved = summary orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings("app.news", resolved.app_id);
    try testing.expectEqualStrings("news", resolved.lifecycle);
    try testing.expectEqual(@as(u8, 10), resolved.frame_rate_hz);
}

test "runner app settings availability reports present for calendar" {
    const testing = @import("std").testing;

    try testing.expectEqualStrings("present", try appSettingsAvailabilityForScene("calendar"));
}

test "runner app settings availability reports present for news" {
    const testing = @import("std").testing;

    try testing.expectEqualStrings("present", try appSettingsAvailabilityForScene("news"));
}

test "runner app settings availability reports present for quotes" {
    const testing = @import("std").testing;

    try testing.expectEqualStrings("present", try appSettingsAvailabilityForScene("quotes"));
}

test "runner app settings availability reports present for transit" {
    const testing = @import("std").testing;

    try testing.expectEqualStrings("present", try appSettingsAvailabilityForScene("transit"));
}

test "runner app settings availability reports missing for clock" {
    const testing = @import("std").testing;

    try testing.expectEqualStrings("missing", try appSettingsAvailabilityForScene("clock"));
}

test "runner startup log payload includes appSettings present for news" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "news",
    });

    const registry = scenes_mod.SceneRegistry.init(logger, "news");
    const runner = RuntimeRunner.init(logger, "simulator", registry);

    var payload_buf: [320]u8 = undefined;
    const payload = try runner.renderStartupLogPayload(&payload_buf);

    try testing.expect(std.mem.indexOf(u8, payload, "\"startupScene\":\"news\"") != null);
    try testing.expect(std.mem.indexOf(u8, payload, "\"appLifecycle\":\"news\"") != null);
    try testing.expect(std.mem.indexOf(u8, payload, "\"appSettings\":\"present\"") != null);
}

test "runner startup log payload includes appSettings present for transit" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .network_probe_mode = .auto,
        .device = "simulator",
        .startup_scene = "transit",
    });

    const registry = scenes_mod.SceneRegistry.init(logger, "transit");
    const runner = RuntimeRunner.init(logger, "simulator", registry);

    var payload_buf: [320]u8 = undefined;
    const payload = try runner.renderStartupLogPayload(&payload_buf);

    try testing.expect(std.mem.indexOf(u8, payload, "\"startupScene\":\"transit\"") != null);
    try testing.expect(std.mem.indexOf(u8, payload, "\"appLifecycle\":\"transit\"") != null);
    try testing.expect(std.mem.indexOf(u8, payload, "\"frameRateHz\":2") != null);
    try testing.expect(std.mem.indexOf(u8, payload, "\"appSettings\":\"present\"") != null);
}

test "runner startup log payload includes appSettings missing when startup scene has no settings" {
    const testing = @import("std").testing;

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

    const registry = scenes_mod.SceneRegistry.init(logger, "clock");
    const runner = RuntimeRunner.init(logger, "simulator", registry);

    var payload_buf: [320]u8 = undefined;
    const payload = try runner.renderStartupLogPayload(&payload_buf);

    try testing.expect(std.mem.indexOf(u8, payload, "\"startupScene\":\"clock\"") != null);
    try testing.expect(std.mem.indexOf(u8, payload, "\"appLifecycle\":\"clock\"") != null);
    try testing.expect(std.mem.indexOf(u8, payload, "\"appSettings\":\"missing\"") != null);
}
