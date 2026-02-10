const std = @import("std");
const types = @import("types.zig");

pub const NewsSceneSettings = struct {
    feed: []const u8,
    max_headlines: u8,
    refresh_interval_min: u16,
};

pub const default_scene_settings = NewsSceneSettings{
    .feed = "frameos",
    .max_headlines = 6,
    .refresh_interval_min = 20,
};

pub const NewsAppLifecycle = struct {
    spec: types.AppSpec,

    pub fn init(spec: types.AppSpec) NewsAppLifecycle {
        return .{ .spec = spec };
    }

    pub fn startup(self: NewsAppLifecycle, ctx: types.AppContext) !types.AppStartupSummary {
        _ = ctx;
        return .{
            .app_id = self.spec.id,
            .lifecycle = "news",
            .frame_rate_hz = 10,
        };
    }
};

pub fn renderSceneSettingsJson(settings: NewsSceneSettings, buffer: []u8) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    const writer = stream.writer();
    try writer.print(
        "{\"feed\":\"{s}\",\"maxHeadlines\":{},\"refreshIntervalMin\":{}}",
        .{ settings.feed, settings.max_headlines, settings.refresh_interval_min },
    );

    return stream.getWritten();
}

test "news lifecycle startup returns deterministic summary" {
    const testing = std.testing;

    const lifecycle = NewsAppLifecycle.init(.{ .id = "app.news", .name = "News", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.news", summary.app_id);
    try testing.expectEqualStrings("news", summary.lifecycle);
    try testing.expectEqual(@as(u8, 10), summary.frame_rate_hz);
}

test "news settings JSON payload renders deterministic defaults" {
    const testing = std.testing;

    var buf: [128]u8 = undefined;
    const payload = try renderSceneSettingsJson(default_scene_settings, &buf);

    try testing.expectEqualStrings(
        "{\"feed\":\"frameos\",\"maxHeadlines\":6,\"refreshIntervalMin\":20}",
        payload,
    );
}
