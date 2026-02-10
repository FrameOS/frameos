const std = @import("std");
const clock_app = @import("clock.zig");
const weather_app = @import("weather.zig");
const calendar_app = @import("calendar.zig");
const types = @import("types.zig");

pub const AppContext = types.AppContext;
pub const AppSpec = types.AppSpec;
pub const AppStartupSummary = types.AppStartupSummary;

pub const AppRuntime = struct {
    spec: AppSpec,

    pub fn init(spec: AppSpec) AppRuntime {
        return .{ .spec = spec };
    }

    pub fn startup(self: AppRuntime, ctx: AppContext) !void {
        _ = self;
        _ = ctx;
    }
};

pub const SceneManifest = struct {
    scene_id: []const u8,
    app: AppSpec,
    entrypoint: []const u8,
};

pub const AppBoundary = struct {
    runtime: AppRuntime,

    pub fn startup(self: AppBoundary, ctx: AppContext) !AppStartupSummary {
        if (std.mem.eql(u8, self.runtime.spec.id, "app.clock")) {
            const lifecycle = clock_app.ClockAppLifecycle.init(self.runtime.spec);
            return lifecycle.startup(ctx);
        }

        if (std.mem.eql(u8, self.runtime.spec.id, "app.weather")) {
            const lifecycle = weather_app.WeatherAppLifecycle.init(self.runtime.spec);
            return lifecycle.startup(ctx);
        }

        if (std.mem.eql(u8, self.runtime.spec.id, "app.calendar")) {
            const lifecycle = calendar_app.CalendarAppLifecycle.init(self.runtime.spec);
            return lifecycle.startup(ctx);
        }

        try self.runtime.startup(ctx);
        return .{
            .app_id = self.runtime.spec.id,
            .lifecycle = "stub",
            .frame_rate_hz = 0,
        };
    }
};

pub fn loadAppBoundaryForScene(scene_id: []const u8) ?AppBoundary {
    const manifest = findSceneManifest(scene_id) orelse return null;

    if (!isAppLifecycleRegistered(manifest.app.id)) {
        return null;
    }

    return .{ .runtime = AppRuntime.init(manifest.app) };
}

pub fn appLifecycleSummaryForScene(scene_id: []const u8, ctx: AppContext) !?AppStartupSummary {
    const boundary = loadAppBoundaryForScene(scene_id) orelse return null;
    return try boundary.startup(ctx);
}

pub fn sceneSettingsPayloadForScene(scene_id: []const u8, buffer: []u8) !?[]const u8 {
    if (std.mem.eql(u8, scene_id, "calendar")) {
        return try calendar_app.renderSceneSettingsJson(calendar_app.default_scene_settings, buffer);
    }

    return null;
}

fn isAppLifecycleRegistered(app_id: []const u8) bool {
    return std.mem.eql(u8, app_id, "app.clock") or std.mem.eql(u8, app_id, "app.weather") or std.mem.eql(u8, app_id, "app.calendar");
}

pub fn builtinSceneManifests() []const SceneManifest {
    return &[_]SceneManifest{
        .{
            .scene_id = "clock",
            .app = .{ .id = "app.clock", .name = "Clock", .version = "0.1.0" },
            .entrypoint = "apps/clock/main",
        },
        .{
            .scene_id = "weather",
            .app = .{ .id = "app.weather", .name = "Weather", .version = "0.1.0" },
            .entrypoint = "apps/weather/main",
        },
        .{
            .scene_id = "calendar",
            .app = .{ .id = "app.calendar", .name = "Calendar", .version = "0.1.0" },
            .entrypoint = "apps/calendar/main",
        },
        .{
            .scene_id = "news",
            .app = .{ .id = "app.news", .name = "News", .version = "0.1.0" },
            .entrypoint = "apps/news/main",
        },
    };
}

pub fn findSceneManifest(scene_id: []const u8) ?SceneManifest {
    for (builtinSceneManifests()) |manifest| {
        if (std.mem.eql(u8, manifest.scene_id, scene_id)) {
            return manifest;
        }
    }

    return null;
}

test "builtin scene manifests include clock" {
    const testing = std.testing;

    const manifest = findSceneManifest("clock") orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings("app.clock", manifest.app.id);
    try testing.expectEqualStrings("apps/clock/main", manifest.entrypoint);
}

test "clock scene app boundary resolves concrete lifecycle summary" {
    const testing = std.testing;

    const boundary = loadAppBoundaryForScene("clock") orelse return error.TestUnexpectedResult;
    const summary = try boundary.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.clock", summary.app_id);
    try testing.expectEqualStrings("clock", summary.lifecycle);
    try testing.expectEqual(@as(u8, 1), summary.frame_rate_hz);
}

test "weather scene app boundary resolves concrete lifecycle summary" {
    const testing = std.testing;

    const boundary = loadAppBoundaryForScene("weather") orelse return error.TestUnexpectedResult;
    const summary = try boundary.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.weather", summary.app_id);
    try testing.expectEqualStrings("weather", summary.lifecycle);
    try testing.expectEqual(@as(u8, 30), summary.frame_rate_hz);
}



test "calendar scene app boundary resolves concrete lifecycle summary" {
    const testing = std.testing;

    const boundary = loadAppBoundaryForScene("calendar") orelse return error.TestUnexpectedResult;
    const summary = try boundary.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.calendar", summary.app_id);
    try testing.expectEqualStrings("calendar", summary.lifecycle);
    try testing.expectEqual(@as(u8, 12), summary.frame_rate_hz);
}

test "app boundary returns null for unregistered lifecycle when manifest exists" {
    const testing = std.testing;

    try testing.expectEqual(@as(?AppBoundary, null), loadAppBoundaryForScene("news"));
}

test "lifecycle summary helper returns null for unregistered lifecycle when manifest exists" {
    const testing = std.testing;

    try testing.expectEqual(@as(?AppStartupSummary, null), try appLifecycleSummaryForScene("news", .{ .allocator = testing.allocator }));
}

test "app boundary returns null for unknown scene" {
    const testing = std.testing;

    try testing.expectEqual(@as(?AppBoundary, null), loadAppBoundaryForScene("unknown-scene"));
}


test "scene settings payload helper renders calendar settings" {
    const testing = std.testing;

    var buf: [128]u8 = undefined;
    const payload = try sceneSettingsPayloadForScene("calendar", &buf);

    try testing.expect(payload != null);
    try testing.expectEqualStrings(
        "{\"timezone\":\"UTC\",\"weekStartsOnMonday\":true,\"maxVisibleEvents\":5}",
        payload.?,
    );
}

test "scene settings payload helper returns null for scenes without settings contracts" {
    const testing = std.testing;

    var buf: [128]u8 = undefined;
    try testing.expectEqual(@as(?[]const u8, null), try sceneSettingsPayloadForScene("news", &buf));
}
