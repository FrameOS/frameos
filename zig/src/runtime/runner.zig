const logger_mod = @import("logger.zig");
const scenes_mod = @import("scenes.zig");

pub const RuntimeRunner = struct {
    logger: logger_mod.RuntimeLogger,
    device: []const u8,
    scene_registry: scenes_mod.SceneRegistry,

    pub fn init(logger: logger_mod.RuntimeLogger, device: []const u8, scene_registry: scenes_mod.SceneRegistry) RuntimeRunner {
        return .{
            .logger = logger,
            .device = device,
            .scene_registry = scene_registry,
        };
    }

    pub fn startup(self: RuntimeRunner) !void {
        const startup_scene = self.scene_registry.resolveStartupScene();

        try self.logger.info(
            "{\"event\":\"runner.start\",\"status\":\"stub\",\"device\":\"{s}\",\"startupScene\":\"{s}\",\"boundary\":\"runtime->apps\"}",
            .{ self.device, startup_scene },
        );
    }
};
