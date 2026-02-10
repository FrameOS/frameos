const std = @import("std");

pub const RuntimeConfig = struct {
    frame_host: []const u8,
    frame_port: u16,
    debug: bool,
    metrics_interval_s: u16,
    network_check: bool,
    device: []const u8,
};

pub fn loadConfig(allocator: std.mem.Allocator) !RuntimeConfig {
    const frame_host = try envOrDefault(allocator, "FRAME_HOST", "127.0.0.1");
    errdefer allocator.free(frame_host);

    const device = try envOrDefault(allocator, "FRAME_DEVICE", "simulator");
    errdefer allocator.free(device);

    return .{
        .frame_host = frame_host,
        .frame_port = try parseEnvInt(u16, "FRAME_PORT", 8787),
        .debug = parseEnvBool("FRAME_DEBUG", false),
        .metrics_interval_s = try parseEnvInt(u16, "FRAME_METRICS_INTERVAL", 60),
        .network_check = parseEnvBool("FRAME_NETWORK_CHECK", true),
        .device = device,
    };
}

pub fn deinitConfig(allocator: std.mem.Allocator, config: RuntimeConfig) void {
    allocator.free(config.frame_host);
    allocator.free(config.device);
}

fn envOrDefault(allocator: std.mem.Allocator, key: []const u8, default: []const u8) ![]const u8 {
    return std.process.getEnvVarOwned(allocator, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, default),
        else => err,
    };
}

fn parseEnvInt(comptime T: type, key: []const u8, default: T) !T {
    var buf: [64]u8 = undefined;
    const value = std.process.getEnvVar(&buf, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return default,
        else => return err,
    };

    return std.fmt.parseInt(T, value, 10) catch default;
}

fn parseEnvBool(key: []const u8, default: bool) bool {
    var buf: [16]u8 = undefined;
    const value = std.process.getEnvVar(&buf, key) catch return default;
    if (std.mem.eql(u8, value, "1") or std.ascii.eqlIgnoreCase(value, "true") or std.ascii.eqlIgnoreCase(value, "yes")) {
        return true;
    }
    if (std.mem.eql(u8, value, "0") or std.ascii.eqlIgnoreCase(value, "false") or std.ascii.eqlIgnoreCase(value, "no")) {
        return false;
    }
    return default;
}
