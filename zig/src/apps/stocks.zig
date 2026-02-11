const std = @import("std");
const types = @import("types.zig");

pub const StocksSceneSettings = struct {
    symbol: []const u8,
    exchange: []const u8,
    range: []const u8,
    refresh_interval_s: u16,
};

pub const default_scene_settings = StocksSceneSettings{
    .symbol = "NVDA",
    .exchange = "NASDAQ",
    .range = "1D",
    .refresh_interval_s = 30,
};

pub const StocksAppLifecycle = struct {
    spec: types.AppSpec,

    pub fn init(spec: types.AppSpec) StocksAppLifecycle {
        return .{ .spec = spec };
    }

    pub fn startup(self: StocksAppLifecycle, ctx: types.AppContext) !types.AppStartupSummary {
        _ = ctx;
        return .{
            .app_id = self.spec.id,
            .lifecycle = "stocks",
            .frame_rate_hz = 4,
        };
    }
};

pub fn renderSceneSettingsJson(settings: StocksSceneSettings, buffer: []u8) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    const writer = stream.writer();
    try writer.print(
        "{\"symbol\":\"{s}\",\"exchange\":\"{s}\",\"range\":\"{s}\",\"refreshIntervalS\":{}}",
        .{ settings.symbol, settings.exchange, settings.range, settings.refresh_interval_s },
    );

    return stream.getWritten();
}

test "stocks lifecycle startup returns deterministic summary" {
    const testing = std.testing;

    const lifecycle = StocksAppLifecycle.init(.{ .id = "app.stocks", .name = "Stocks", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.stocks", summary.app_id);
    try testing.expectEqualStrings("stocks", summary.lifecycle);
    try testing.expectEqual(@as(u8, 4), summary.frame_rate_hz);
}

test "stocks settings JSON payload renders deterministic defaults" {
    const testing = std.testing;

    var buf: [160]u8 = undefined;
    const payload = try renderSceneSettingsJson(default_scene_settings, &buf);

    try testing.expectEqualStrings(
        "{\"symbol\":\"NVDA\",\"exchange\":\"NASDAQ\",\"range\":\"1D\",\"refreshIntervalS\":30}",
        payload,
    );
}
