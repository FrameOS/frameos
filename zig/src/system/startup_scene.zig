pub const SystemStartupScene = enum {
    index,
    wifi_hotspot,
};

pub fn startupSceneLabel(scene: SystemStartupScene) []const u8 {
    return switch (scene) {
        .index => "index",
        .wifi_hotspot => "wifi-hotspot",
    };
}
