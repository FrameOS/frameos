const std = @import("std");
const clock_app = @import("clock.zig");
const weather_app = @import("weather.zig");
const calendar_app = @import("calendar.zig");
const news_app = @import("news.zig");
const quotes_app = @import("quotes.zig");
const transit_app = @import("transit.zig");
const stocks_app = @import("stocks.zig");
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

        if (std.mem.eql(u8, self.runtime.spec.id, "app.news")) {
            const lifecycle = news_app.NewsAppLifecycle.init(self.runtime.spec);
            return lifecycle.startup(ctx);
        }

        if (std.mem.eql(u8, self.runtime.spec.id, "app.quotes")) {
            const lifecycle = quotes_app.QuotesAppLifecycle.init(self.runtime.spec);
            return lifecycle.startup(ctx);
        }

        if (std.mem.eql(u8, self.runtime.spec.id, "app.transit")) {
            const lifecycle = transit_app.TransitAppLifecycle.init(self.runtime.spec);
            return lifecycle.startup(ctx);
        }

        if (std.mem.eql(u8, self.runtime.spec.id, "app.stocks")) {
            const lifecycle = stocks_app.StocksAppLifecycle.init(self.runtime.spec);
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

    if (std.mem.eql(u8, scene_id, "weather")) {
        return try weather_app.renderSceneSettingsJson(weather_app.default_scene_settings, buffer);
    }

    if (std.mem.eql(u8, scene_id, "news")) {
        return try news_app.renderSceneSettingsJson(news_app.default_scene_settings, buffer);
    }

    if (std.mem.eql(u8, scene_id, "quotes")) {
        return try quotes_app.renderSceneSettingsJson(quotes_app.default_scene_settings, buffer);
    }

    if (std.mem.eql(u8, scene_id, "transit")) {
        return try transit_app.renderSceneSettingsJson(transit_app.default_scene_settings, buffer);
    }

    if (std.mem.eql(u8, scene_id, "stocks")) {
        return try stocks_app.renderSceneSettingsJson(stocks_app.default_scene_settings, buffer);
    }

    return null;
}

pub fn sceneSettingsAvailableForScene(scene_id: []const u8) bool {
    return std.mem.eql(u8, scene_id, "calendar") or std.mem.eql(u8, scene_id, "weather") or std.mem.eql(u8, scene_id, "news") or std.mem.eql(u8, scene_id, "quotes") or std.mem.eql(u8, scene_id, "transit") or std.mem.eql(u8, scene_id, "stocks");
}

fn isAppLifecycleRegistered(app_id: []const u8) bool {
    return std.mem.eql(u8, app_id, "app.clock") or std.mem.eql(u8, app_id, "app.weather") or std.mem.eql(u8, app_id, "app.calendar") or std.mem.eql(u8, app_id, "app.news") or std.mem.eql(u8, app_id, "app.quotes") or std.mem.eql(u8, app_id, "app.transit") or std.mem.eql(u8, app_id, "app.stocks");
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
        .{
            .scene_id = "quotes",
            .app = .{ .id = "app.quotes", .name = "Quotes", .version = "0.1.0" },
            .entrypoint = "apps/quotes/main",
        },
        .{
            .scene_id = "transit",
            .app = .{ .id = "app.transit", .name = "Transit", .version = "0.1.0" },
            .entrypoint = "apps/transit/main",
        },
        .{
            .scene_id = "stocks",
            .app = .{ .id = "app.stocks", .name = "Stocks", .version = "0.1.0" },
            .entrypoint = "apps/stocks/main",
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

test "news scene app boundary resolves concrete lifecycle summary" {
    const testing = std.testing;

    const boundary = loadAppBoundaryForScene("news") orelse return error.TestUnexpectedResult;
    const summary = try boundary.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.news", summary.app_id);
    try testing.expectEqualStrings("news", summary.lifecycle);
    try testing.expectEqual(@as(u8, 10), summary.frame_rate_hz);
}


test "quotes scene app boundary resolves concrete lifecycle summary" {
    const testing = std.testing;

    const boundary = loadAppBoundaryForScene("quotes") orelse return error.TestUnexpectedResult;
    const summary = try boundary.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.quotes", summary.app_id);
    try testing.expectEqualStrings("quotes", summary.lifecycle);
    try testing.expectEqual(@as(u8, 8), summary.frame_rate_hz);
}

test "transit scene app boundary resolves concrete lifecycle summary" {
    const testing = std.testing;

    const boundary = loadAppBoundaryForScene("transit") orelse return error.TestUnexpectedResult;
    const summary = try boundary.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.transit", summary.app_id);
    try testing.expectEqualStrings("transit", summary.lifecycle);
    try testing.expectEqual(@as(u8, 2), summary.frame_rate_hz);
}

test "stocks scene app boundary resolves concrete lifecycle summary" {
    const testing = std.testing;

    const boundary = loadAppBoundaryForScene("stocks") orelse return error.TestUnexpectedResult;
    const summary = try boundary.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.stocks", summary.app_id);
    try testing.expectEqualStrings("stocks", summary.lifecycle);
    try testing.expectEqual(@as(u8, 4), summary.frame_rate_hz);
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
    try testing.expectEqual(@as(?[]const u8, null), try sceneSettingsPayloadForScene("clock", &buf));
}

test "scene settings availability helper reports support by scene" {
    const testing = std.testing;

    try testing.expect(sceneSettingsAvailableForScene("calendar"));
    try testing.expect(sceneSettingsAvailableForScene("weather"));
    try testing.expect(!sceneSettingsAvailableForScene("clock"));
    try testing.expect(sceneSettingsAvailableForScene("news"));
    try testing.expect(sceneSettingsAvailableForScene("quotes"));
    try testing.expect(sceneSettingsAvailableForScene("transit"));
    try testing.expect(sceneSettingsAvailableForScene("stocks"));
}

test "scene settings payload helper renders weather settings" {
    const testing = std.testing;

    var buf: [160]u8 = undefined;
    const payload = try sceneSettingsPayloadForScene("weather", &buf);

    try testing.expect(payload != null);
    try testing.expectEqualStrings(
        "{\"location\":\"San Francisco, CA\",\"units\":\"metric\",\"refreshIntervalMin\":15}",
        payload.?,
    );
}

test "scene settings payload helper renders news settings" {
    const testing = std.testing;

    var buf: [128]u8 = undefined;
    const payload = try sceneSettingsPayloadForScene("news", &buf);

    try testing.expect(payload != null);
    try testing.expectEqualStrings(
        "{\"feed\":\"frameos\",\"maxHeadlines\":6,\"refreshIntervalMin\":20}",
        payload.?,
    );
}


test "scene settings payload helper renders quotes settings" {
    const testing = std.testing;

    var buf: [128]u8 = undefined;
    const payload = try sceneSettingsPayloadForScene("quotes", &buf);

    try testing.expect(payload != null);
    try testing.expectEqualStrings(
        "{\"feed\":\"zen\",\"maxQuotes\":5,\"refreshIntervalMin\":30}",
        payload.?,
    );
}

test "scene settings payload helper renders transit settings" {
    const testing = std.testing;

    var buf: [160]u8 = undefined;
    const payload = try sceneSettingsPayloadForScene("transit", &buf);

    try testing.expect(payload != null);
    try testing.expectEqualStrings(
        "{\"stopId\":\"sf-muni-judah-outbound\",\"direction\":\"outbound\",\"refreshIntervalS\":45}",
        payload.?,
    );
}

test "scene settings payload helper renders stocks settings" {
    const testing = std.testing;

    var buf: [192]u8 = undefined;
    const payload = try sceneSettingsPayloadForScene("stocks", &buf);

    try testing.expect(payload != null);
    try testing.expectEqualStrings(
        "{\"symbol\":\"NVDA\",\"exchange\":\"NASDAQ\",\"range\":\"1D\",\"refreshIntervalS\":30}",
        payload.?,
    );
}

test "app contract parity payloads stay aligned with Nim-shaped expectations" {
    const testing = std.testing;

    const clock_summary = try appLifecycleSummaryForScene("clock", .{ .allocator = testing.allocator });
    try testing.expect(clock_summary != null);
    try testing.expectEqualStrings("clock", clock_summary.?.lifecycle);

    const weather_summary = try appLifecycleSummaryForScene("weather", .{ .allocator = testing.allocator });
    try testing.expect(weather_summary != null);
    try testing.expectEqualStrings("weather", weather_summary.?.lifecycle);

    const calendar_summary = try appLifecycleSummaryForScene("calendar", .{ .allocator = testing.allocator });
    try testing.expect(calendar_summary != null);
    try testing.expectEqualStrings("calendar", calendar_summary.?.lifecycle);

    const news_summary = try appLifecycleSummaryForScene("news", .{ .allocator = testing.allocator });
    try testing.expect(news_summary != null);
    try testing.expectEqualStrings("news", news_summary.?.lifecycle);

    const transit_summary = try appLifecycleSummaryForScene("transit", .{ .allocator = testing.allocator });
    try testing.expect(transit_summary != null);
    try testing.expectEqualStrings("transit", transit_summary.?.lifecycle);

    const stocks_summary = try appLifecycleSummaryForScene("stocks", .{ .allocator = testing.allocator });
    try testing.expect(stocks_summary != null);
    try testing.expectEqualStrings("stocks", stocks_summary.?.lifecycle);

    var buf: [256]u8 = undefined;
    try testing.expectEqualStrings(
        "{\"location\":\"San Francisco, CA\",\"units\":\"metric\",\"refreshIntervalMin\":15}",
        (try sceneSettingsPayloadForScene("weather", &buf)).?,
    );
    try testing.expectEqualStrings(
        "{\"timezone\":\"UTC\",\"weekStartsOnMonday\":true,\"maxVisibleEvents\":5}",
        (try sceneSettingsPayloadForScene("calendar", &buf)).?,
    );
    try testing.expectEqualStrings(
        "{\"feed\":\"frameos\",\"maxHeadlines\":6,\"refreshIntervalMin\":20}",
        (try sceneSettingsPayloadForScene("news", &buf)).?,
    );
    try testing.expectEqualStrings(
        "{\"stopId\":\"sf-muni-judah-outbound\",\"direction\":\"outbound\",\"refreshIntervalS\":45}",
        (try sceneSettingsPayloadForScene("transit", &buf)).?,
    );
    try testing.expectEqualStrings(
        "{\"symbol\":\"NVDA\",\"exchange\":\"NASDAQ\",\"range\":\"1D\",\"refreshIntervalS\":30}",
        (try sceneSettingsPayloadForScene("stocks", &buf)).?,
    );
}
