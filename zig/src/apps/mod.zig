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

pub const SceneManifest = struct {
    scene_id: []const u8,
    app: AppSpec,
    entrypoint: []const u8,
};

pub fn builtinSceneManifests() []const SceneManifest {
    return &[_]SceneManifest{
        .{
            .scene_id = "clock",
            .app = .{ .id = "app.clock", .name = "Clock", .version = "0.1.0" },
            .entrypoint = "apps/clock/main",
        },
        .{
            .scene_id = "weather",
            .app = .{ .id = "app.weather", .name = "Weather", .version = "0.1.0" },
            .entrypoint = "apps/weather/main",
        },
        .{
            .scene_id = "calendar",
            .app = .{ .id = "app.calendar", .name = "Calendar", .version = "0.1.0" },
            .entrypoint = "apps/calendar/main",
        },
    };
}

pub fn findSceneManifest(scene_id: []const u8) ?SceneManifest {
    for (builtinSceneManifests()) |manifest| {
        if (std.mem.eql(u8, manifest.scene_id, scene_id)) {
            return manifest;
        }
    }

    return null;
}

test "builtin scene manifests include clock" {
    const testing = std.testing;

    const manifest = findSceneManifest("clock") orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings("app.clock", manifest.app.id);
    try testing.expectEqualStrings("apps/clock/main", manifest.entrypoint);
}
