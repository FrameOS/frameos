const std = @import("std");
const types = @import("types.zig");

pub const CalendarSceneSettings = struct {
    timezone: []const u8,
    week_starts_on_monday: bool,
    max_visible_events: u8,
};

pub const default_scene_settings = CalendarSceneSettings{
    .timezone = "UTC",
    .week_starts_on_monday = true,
    .max_visible_events = 5,
};

pub const CalendarAppLifecycle = struct {
    spec: types.AppSpec,

    pub fn init(spec: types.AppSpec) CalendarAppLifecycle {
        return .{ .spec = spec };
    }

    pub fn startup(self: CalendarAppLifecycle, ctx: types.AppContext) !types.AppStartupSummary {
        _ = ctx;
        return .{
            .app_id = self.spec.id,
            .lifecycle = "calendar",
            .frame_rate_hz = 12,
        };
    }
};

pub fn renderSceneSettingsJson(settings: CalendarSceneSettings, buffer: []u8) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    const writer = stream.writer();
    try writer.print(
        "{\"timezone\":\"{s}\",\"weekStartsOnMonday\":{},\"maxVisibleEvents\":{}}",
        .{ settings.timezone, settings.week_starts_on_monday, settings.max_visible_events },
    );

    return stream.getWritten();
}

test "calendar lifecycle startup returns deterministic summary" {
    const testing = std.testing;

    const lifecycle = CalendarAppLifecycle.init(.{ .id = "app.calendar", .name = "Calendar", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.calendar", summary.app_id);
    try testing.expectEqualStrings("calendar", summary.lifecycle);
    try testing.expectEqual(@as(u8, 12), summary.frame_rate_hz);
}

test "calendar settings JSON payload renders deterministic defaults" {
    const testing = std.testing;

    var buf: [128]u8 = undefined;
    const payload = try renderSceneSettingsJson(default_scene_settings, &buf);

    try testing.expectEqualStrings(
        "{\"timezone\":\"UTC\",\"weekStartsOnMonday\":true,\"maxVisibleEvents\":5}",
        payload,
    );
}
