const std = @import("std");
const types = @import("types.zig");

pub const PhotoSceneSettings = struct {
    album: []const u8,
    transition: []const u8,
    refresh_interval_s: u16,
};

pub const default_scene_settings = PhotoSceneSettings{
    .album = "favorites",
    .transition = "fade",
    .refresh_interval_s = 20,
};

pub const PhotoAppLifecycle = struct {
    spec: types.AppSpec,

    pub fn init(spec: types.AppSpec) PhotoAppLifecycle {
        return .{ .spec = spec };
    }

    pub fn startup(self: PhotoAppLifecycle, ctx: types.AppContext) !types.AppStartupSummary {
        _ = ctx;
        return .{
            .app_id = self.spec.id,
            .lifecycle = "photo",
            .frame_rate_hz = 12,
        };
    }
};

pub fn renderSceneSettingsJson(settings: PhotoSceneSettings, buffer: []u8) ![]const u8 {
    var stream = std.io.fixedBufferStream(buffer);
    const writer = stream.writer();
    try writer.print(
        "{\"album\":\"{s}\",\"transition\":\"{s}\",\"refreshIntervalS\":{}}",
        .{ settings.album, settings.transition, settings.refresh_interval_s },
    );

    return stream.getWritten();
}

test "photo lifecycle startup returns deterministic summary" {
    const testing = std.testing;

    const lifecycle = PhotoAppLifecycle.init(.{ .id = "app.photo", .name = "Photo", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.photo", summary.app_id);
    try testing.expectEqualStrings("photo", summary.lifecycle);
    try testing.expectEqual(@as(u8, 12), summary.frame_rate_hz);
}

test "photo settings JSON payload renders deterministic defaults" {
    const testing = std.testing;

    var buf: [128]u8 = undefined;
    const payload = try renderSceneSettingsJson(default_scene_settings, &buf);

    try testing.expectEqualStrings(
        "{\"album\":\"favorites\",\"transition\":\"fade\",\"refreshIntervalS\":20}",
        payload,
    );
}
