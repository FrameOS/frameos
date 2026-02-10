const std = @import("std");

pub const AppContext = struct {
    allocator: std.mem.Allocator,
};

pub const AppSpec = struct {
    id: []const u8,
    name: []const u8,
    version: []const u8,
};

pub const AppRuntime = struct {
    spec: AppSpec,

    pub fn init(spec: AppSpec) AppRuntime {
        return .{ .spec = spec };
    }

    pub fn startup(self: AppRuntime, ctx: AppContext) !void {
        _ = self;
        _ = ctx;
    }
};
