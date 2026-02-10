const std = @import("std");
const simulator = @import("simulator.zig");

pub const DriverKind = enum {
    simulator,
    framebuffer,
    gpio,
    transport,
};

pub const DriverConfig = struct {
    id: []const u8,
    enabled: bool,
    kind: DriverKind,
};

pub const DriverContext = struct {
    allocator: std.mem.Allocator,
};

pub const DriverStartup = union(DriverKind) {
    simulator: simulator.SimulatorStartup,
    framebuffer: void,
    gpio: void,
    transport: void,
};

pub const DriverBoundary = struct {
    config: DriverConfig,

    pub fn init(config: DriverConfig) DriverBoundary {
        return .{ .config = config };
    }

    pub fn startup(self: DriverBoundary, ctx: DriverContext) !DriverStartup {
        _ = ctx;

        return switch (self.config.kind) {
            .simulator => .{ .simulator = try (try simulator.SimulatorDriver.init(self.config)).startup() },
            .framebuffer => .{ .framebuffer = {} },
            .gpio => .{ .gpio = {} },
            .transport => .{ .transport = {} },
        };
    }
};

pub fn configForDevice(device: []const u8) DriverConfig {
    if (std.mem.eql(u8, device, "simulator")) {
        return .{ .id = "sim-0", .enabled = true, .kind = .simulator };
    }

    if (std.mem.eql(u8, device, "framebuffer")) {
        return .{ .id = "fb-0", .enabled = true, .kind = .framebuffer };
    }

    return .{ .id = "sim-fallback", .enabled = true, .kind = .simulator };
}

test "configForDevice keeps simulator mapping" {
    const testing = std.testing;

    const config = configForDevice("simulator");

    try testing.expectEqual(DriverKind.simulator, config.kind);
    try testing.expectEqualStrings("sim-0", config.id);
}

test "configForDevice falls back to simulator for unknown device" {
    const testing = std.testing;

    const config = configForDevice("unknown-hardware");

    try testing.expectEqual(DriverKind.simulator, config.kind);
    try testing.expectEqualStrings("sim-fallback", config.id);
}
