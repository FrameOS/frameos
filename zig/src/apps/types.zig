const std = @import("std");

pub const AppContext = struct {
    allocator: std.mem.Allocator,
};

pub const AppSpec = struct {
    id: []const u8,
    name: []const u8,
    version: []const u8,
};

pub const AppStartupSummary = struct {
    app_id: []const u8,
    lifecycle: []const u8,
    frame_rate_hz: u8,
};
