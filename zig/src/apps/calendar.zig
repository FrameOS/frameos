const types = @import("types.zig");

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

test "calendar lifecycle startup returns deterministic summary" {
    const testing = @import("std").testing;

    const lifecycle = CalendarAppLifecycle.init(.{ .id = "app.calendar", .name = "Calendar", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.calendar", summary.app_id);
    try testing.expectEqualStrings("calendar", summary.lifecycle);
    try testing.expectEqual(@as(u8, 12), summary.frame_rate_hz);
}
