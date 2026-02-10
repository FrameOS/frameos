const std = @import("std");
const types = @import("types.zig");

pub const TransitSceneSettings = struct {
    stop_id: []const u8,
    direction: []const u8,
    refresh_interval_s: u16,
};

pub const default_scene_settings = TransitSceneSettings{
    .stop_id = "sf-muni-judah-outbound",
    .direction = "outbound",
    .refresh_interval_s = 45,
};

pub const TransitAppLifecycle = struct {
    spec: types.AppSpec,

    pub fn init(spec: types.AppSpec) TransitAppLifecycle {
        return .{ .spec = spec };
    }

    pub fn startup(self: TransitAppLifecycle, ctx: types.AppContext) !types.AppStartupSummary {
        _ = ctx;
        return .{
            .app_id = self.spec.id,
            .lifecycle = "transit",
            .frame_rate_hz = 2,
        };
    }
};

pub fn renderSceneSettingsJson(settings: TransitSceneSettings, buffer: []u8) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    const writer = stream.writer();
    try writer.print(
        "{\"stopId\":\"{s}\",\"direction\":\"{s}\",\"refreshIntervalS\":{}}",
        .{ settings.stop_id, settings.direction, settings.refresh_interval_s },
    );

    return stream.getWritten();
}

test "transit lifecycle startup returns deterministic summary" {
    const testing = std.testing;

    const lifecycle = TransitAppLifecycle.init(.{ .id = "app.transit", .name = "Transit", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.transit", summary.app_id);
    try testing.expectEqualStrings("transit", summary.lifecycle);
    try testing.expectEqual(@as(u8, 2), summary.frame_rate_hz);
}

test "transit settings JSON payload renders deterministic defaults" {
    const testing = std.testing;

    var buf: [160]u8 = undefined;
    const payload = try renderSceneSettingsJson(default_scene_settings, &buf);

    try testing.expectEqualStrings(
        "{\"stopId\":\"sf-muni-judah-outbound\",\"direction\":\"outbound\",\"refreshIntervalS\":45}",
        payload,
    );
}
