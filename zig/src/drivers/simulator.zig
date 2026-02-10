const std = @import("std");
const drivers_mod = @import("mod.zig");

pub const SimulatorStartup = struct {
    backend: []const u8,
    refresh_hz: u8,
};

pub const SimulatorDriver = struct {
    config: drivers_mod.DriverConfig,

    pub fn init(config: drivers_mod.DriverConfig) !SimulatorDriver {
        if (config.kind != .simulator) {
            return error.InvalidDriverKind;
        }

        return .{ .config = config };
    }

    pub fn startup(self: SimulatorDriver) !SimulatorStartup {
        if (!self.config.enabled) {
            return error.DriverDisabled;
        }

        return .{
            .backend = "memory",
            .refresh_hz = 1,
        };
    }
};

test "simulator startup reports default capabilities" {
    const testing = std.testing;

    const driver = try SimulatorDriver.init(.{
        .id = "sim-0",
        .enabled = true,
        .kind = .simulator,
    });

    const startup = try driver.startup();

    try testing.expectEqualStrings("memory", startup.backend);
    try testing.expectEqual(@as(u8, 1), startup.refresh_hz);
}
