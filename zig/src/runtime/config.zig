const std = @import("std");

pub const RuntimeConfig = struct {
    frame_host: []const u8,
    frame_port: u16,
    debug: bool,
    metrics_interval_s: u16,
    network_check: bool,
    network_probe_mode: NetworkProbeMode,
    device: []const u8,
    startup_scene: []const u8,
};

pub const NetworkProbeMode = enum {
    auto,
    force_ok,
    force_failed,
};

pub fn loadConfig(allocator: std.mem.Allocator) !RuntimeConfig {
    const frame_host = try envOrDefault(allocator, "FRAME_HOST", "127.0.0.1");
    errdefer allocator.free(frame_host);

    const device = try envOrDefault(allocator, "FRAME_DEVICE", "simulator");
    errdefer allocator.free(device);

    const startup_scene = try envOrDefault(allocator, "FRAME_STARTUP_SCENE", "clock");
    errdefer allocator.free(startup_scene);

    return .{
        .frame_host = frame_host,
        .frame_port = parseEnvInt(u16, "FRAME_PORT", 8787),
        .debug = parseEnvBool("FRAME_DEBUG", false),
        .metrics_interval_s = parseEnvInt(u16, "FRAME_METRICS_INTERVAL", 60),
        .network_check = parseEnvBool("FRAME_NETWORK_CHECK", true),
        .network_probe_mode = parseEnvProbeMode("FRAME_NETWORK_PROBE_MODE", .auto),
        .device = device,
        .startup_scene = startup_scene,
    };
}

pub fn deinitConfig(allocator: std.mem.Allocator, config: RuntimeConfig) void {
    allocator.free(config.frame_host);
    allocator.free(config.device);
    allocator.free(config.startup_scene);
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

fn parseEnvProbeMode(key: []const u8, default: NetworkProbeMode) NetworkProbeMode {
    var buf: [32]u8 = undefined;
    const value = std.process.getEnvVar(&buf, key) catch return default;
    return parseProbeModeOrDefault(value, default);
}

pub fn parseProbeModeOrDefault(value: ?[]const u8, default: NetworkProbeMode) NetworkProbeMode {
    const raw = value orelse return default;

    if (std.ascii.eqlIgnoreCase(raw, "auto")) {
        return .auto;
    }
    if (std.ascii.eqlIgnoreCase(raw, "force-ok") or std.ascii.eqlIgnoreCase(raw, "force_ok") or std.ascii.eqlIgnoreCase(raw, "ok")) {
        return .force_ok;
    }
    if (std.ascii.eqlIgnoreCase(raw, "force-failed") or std.ascii.eqlIgnoreCase(raw, "force_failed") or std.ascii.eqlIgnoreCase(raw, "failed")) {
        return .force_failed;
    }

    return default;
}

pub fn probeModeLabel(mode: NetworkProbeMode) []const u8 {
    return switch (mode) {
        .auto => "auto",
        .force_ok => "force-ok",
        .force_failed => "force-failed",
    };
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

test "parse network probe mode values and defaults" {
    const testing = std.testing;

    try testing.expectEqual(NetworkProbeMode.auto, parseProbeModeOrDefault("auto", .force_failed));
    try testing.expectEqual(NetworkProbeMode.force_ok, parseProbeModeOrDefault("force-ok", .auto));
    try testing.expectEqual(NetworkProbeMode.force_ok, parseProbeModeOrDefault("OK", .auto));
    try testing.expectEqual(NetworkProbeMode.force_failed, parseProbeModeOrDefault("force_failed", .auto));
    try testing.expectEqual(NetworkProbeMode.auto, parseProbeModeOrDefault("invalid", .auto));
    try testing.expectEqual(NetworkProbeMode.force_failed, parseProbeModeOrDefault(null, .force_failed));
}
