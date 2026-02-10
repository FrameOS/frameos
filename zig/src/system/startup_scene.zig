pub const SystemStartupScene = enum {
    index,
    wifi_hotspot,
};

pub const SystemStartupState = enum {
    booting,
    degraded_network,
    ready,
};

pub fn startupSceneLabel(scene: SystemStartupScene) []const u8 {
    return switch (scene) {
        .index => "index",
        .wifi_hotspot => "wifi-hotspot",
    };
}

pub fn startupStateLabel(state: SystemStartupState) []const u8 {
    return switch (state) {
        .booting => "booting",
        .degraded_network => "degraded-network",
        .ready => "ready",
    };
}
