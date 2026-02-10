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
        .frame_port = parseEnvInt(u16, "FRAME_PORT", 8787),
        .debug = parseEnvBool("FRAME_DEBUG", false),
        .metrics_interval_s = parseEnvInt(u16, "FRAME_METRICS_INTERVAL", 60),
        .network_check = parseEnvBool("FRAME_NETWORK_CHECK", true),
        .device = device,
    };
}

pub fn deinitConfig(allocator: std.mem.Allocator, config: RuntimeConfig) void {
    allocator.free(config.frame_host);
    allocator.free(config.device);
}

pub fn parseIntOrDefault(comptime T: type, value: ?[]const u8, default: T) T {
    const raw = value orelse return default;
    return std.fmt.parseInt(T, raw, 10) catch default;
}

pub fn parseBoolOrDefault(value: ?[]const u8, default: bool) bool {
    const raw = value orelse return default;
    if (std.mem.eql(u8, raw, "1") or std.ascii.eqlIgnoreCase(raw, "true") or std.ascii.eqlIgnoreCase(raw, "yes")) {
        return true;
    }
    if (std.mem.eql(u8, raw, "0") or std.ascii.eqlIgnoreCase(raw, "false") or std.ascii.eqlIgnoreCase(raw, "no")) {
        return false;
    }
    return default;
}

fn envOrDefault(allocator: std.mem.Allocator, key: []const u8, default: []const u8) ![]const u8 {
    return std.process.getEnvVarOwned(allocator, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, default),
        else => err,
    };
}

fn parseEnvInt(comptime T: type, key: []const u8, default: T) T {
    var buf: [64]u8 = undefined;
    const value = std.process.getEnvVar(&buf, key) catch return default;
    return parseIntOrDefault(T, value, default);
}

fn parseEnvBool(key: []const u8, default: bool) bool {
    var buf: [16]u8 = undefined;
    const value = std.process.getEnvVar(&buf, key) catch return default;
    return parseBoolOrDefault(value, default);
}

test "parse bool defaults and values" {
    const testing = std.testing;

    try testing.expect(parseBoolOrDefault("true", false));
    try testing.expect(parseBoolOrDefault("YES", false));
    try testing.expect(!parseBoolOrDefault("0", true));
    try testing.expect(parseBoolOrDefault(null, true));
    try testing.expect(!parseBoolOrDefault("not-a-bool", false));
}

test "parse int defaults and invalid values" {
    const testing = std.testing;

    try testing.expectEqual(@as(u16, 99), parseIntOrDefault(u16, "99", 10));
    try testing.expectEqual(@as(u16, 10), parseIntOrDefault(u16, "oops", 10));
    try testing.expectEqual(@as(u16, 10), parseIntOrDefault(u16, null, 10));
}
