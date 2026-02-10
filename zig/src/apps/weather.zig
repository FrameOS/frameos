const types = @import("types.zig");

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

test "weather lifecycle startup returns deterministic summary" {
    const testing = @import("std").testing;

    const lifecycle = WeatherAppLifecycle.init(.{ .id = "app.weather", .name = "Weather", .version = "0.1.0" });
    const summary = try lifecycle.startup(.{ .allocator = testing.allocator });

    try testing.expectEqualStrings("app.weather", summary.app_id);
    try testing.expectEqualStrings("weather", summary.lifecycle);
    try testing.expectEqual(@as(u8, 30), summary.frame_rate_hz);
}
