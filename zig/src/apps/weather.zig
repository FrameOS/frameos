const std = @import("std");
const types = @import("types.zig");

pub const WeatherSceneSettings = struct {
    location: []const u8,
    units: []const u8,
    refresh_interval_min: u16,
};

pub const default_scene_settings = WeatherSceneSettings{
    .location = "San Francisco, CA",
    .units = "metric",
    .refresh_interval_min = 15,
};

pub const WeatherAppLifecycle = struct {
    spec: types.AppSpec,

    pub fn init(spec: types.AppSpec) WeatherAppLifecycle {
        return .{ .spec = spec };
    }

    pub fn startup(self: WeatherAppLifecycle, ctx: types.AppContext) !types.AppStartupSummary {
        _ = ctx;
        return .{
            .app_id = self.spec.id,
            .lifecycle = "weather",
            .frame_rate_hz = 30,
        };
    }
};

pub fn renderSceneSettingsJson(settings: WeatherSceneSettings, buffer: []u8) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    const writer = stream.writer();
    try writer.print(
        "{\"location\":\"{s}\",\"units\":\"{s}\",\"refreshIntervalMin\":{}}",
        .{ settings.location, settings.units, settings.refresh_interval_min },
    );

    return stream.getWritten();
}

test "weather lifecycle startup returns deterministic summary" {
    const testing = @import("std").testing;

    const lifecycle = WeatherAppLifecycle.init(.{ .id = "app.weather", .name = "Weather", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.weather", summary.app_id);
    try testing.expectEqualStrings("weather", summary.lifecycle);
    try testing.expectEqual(@as(u8, 30), summary.frame_rate_hz);
}

test "weather settings JSON payload renders deterministic defaults" {
    const testing = @import("std").testing;

    var buf: [128]u8 = undefined;
    const payload = try renderSceneSettingsJson(default_scene_settings, &buf);

    try testing.expectEqualStrings(
        "{\"location\":\"San Francisco, CA\",\"units\":\"metric\",\"refreshIntervalMin\":15}",
        payload,
    );
}
