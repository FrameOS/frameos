const std = @import("std");

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

pub const DriverBoundary = struct {
    config: DriverConfig,

    pub fn init(config: DriverConfig) DriverBoundary {
        return .{ .config = config };
    }

    pub fn startup(self: DriverBoundary, ctx: DriverContext) !void {
        _ = self;
        _ = ctx;
    }
};
