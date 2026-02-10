const types = @import("types.zig");

pub const ClockAppLifecycle = struct {
    spec: types.AppSpec,

    pub fn init(spec: types.AppSpec) ClockAppLifecycle {
        return .{ .spec = spec };
    }

    pub fn startup(self: ClockAppLifecycle, ctx: types.AppContext) !types.AppStartupSummary {
        _ = ctx;
        return .{
            .app_id = self.spec.id,
            .lifecycle = "clock",
            .frame_rate_hz = 1,
        };
    }
};

test "clock lifecycle startup returns deterministic summary" {
    const testing = @import("std").testing;

    const lifecycle = ClockAppLifecycle.init(.{ .id = "app.clock", .name = "Clock", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.clock", summary.app_id);
    try testing.expectEqualStrings("clock", summary.lifecycle);
    try testing.expectEqual(@as(u8, 1), summary.frame_rate_hz);
}
