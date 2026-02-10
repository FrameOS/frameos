const std = @import("std");
const types = @import("types.zig");

pub const QuotesSceneSettings = struct {
    feed: []const u8,
    max_quotes: u8,
    refresh_interval_min: u16,
};

pub const default_scene_settings = QuotesSceneSettings{
    .feed = "zen",
    .max_quotes = 5,
    .refresh_interval_min = 30,
};

pub const QuotesAppLifecycle = struct {
    spec: types.AppSpec,

    pub fn init(spec: types.AppSpec) QuotesAppLifecycle {
        return .{ .spec = spec };
    }

    pub fn startup(self: QuotesAppLifecycle, ctx: types.AppContext) !types.AppStartupSummary {
        _ = ctx;
        return .{
            .app_id = self.spec.id,
            .lifecycle = "quotes",
            .frame_rate_hz = 8,
        };
    }
};

pub fn renderSceneSettingsJson(settings: QuotesSceneSettings, buffer: []u8) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    const writer = stream.writer();
    try writer.print(
        "{\"feed\":\"{s}\",\"maxQuotes\":{},\"refreshIntervalMin\":{}}",
        .{ settings.feed, settings.max_quotes, settings.refresh_interval_min },
    );

    return stream.getWritten();
}

test "quotes lifecycle startup returns deterministic summary" {
    const testing = std.testing;

    const lifecycle = QuotesAppLifecycle.init(.{ .id = "app.quotes", .name = "Quotes", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.quotes", summary.app_id);
    try testing.expectEqualStrings("quotes", summary.lifecycle);
    try testing.expectEqual(@as(u8, 8), summary.frame_rate_hz);
}

test "quotes settings JSON payload renders deterministic defaults" {
    const testing = std.testing;

    var buf: [128]u8 = undefined;
    const payload = try renderSceneSettingsJson(default_scene_settings, &buf);

    try testing.expectEqualStrings(
        "{\"feed\":\"zen\",\"maxQuotes\":5,\"refreshIntervalMin\":30}",
        payload,
    );
}
