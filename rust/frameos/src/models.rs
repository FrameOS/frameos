use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Runtime status snapshot for the frame process.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrameStatus {
    Booting,
    Idle,
    Rendering,
    Error,
}

/// Canonical frame state model exchanged over JSON boundaries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrameState {
    pub frame_id: String,
    pub status: FrameStatus,
    pub active_scene: Option<String>,
    pub width: u32,
    pub height: u32,
    pub rotated: i32,
    pub last_error: Option<String>,
}

/// Scene source description for resolving scene payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SceneSource {
    AssetPath { path: String },
    InlineJson,
    RemoteUrl { url: String },
}

/// Scene descriptor model for internal cataloging and API payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SceneDescriptor {
    pub id: String,
    pub app_id: String,
    pub version: String,
    pub source: SceneSource,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

/// Manifest entry for a runnable app.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppDescriptor {
    pub id: String,
    pub display_name: String,
    pub executable: String,
    pub entry_scene: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_scene_descriptor_to_json() {
        let scene = SceneDescriptor {
            id: "clock/default".to_string(),
            app_id: "clock".to_string(),
            version: "1.0.0".to_string(),
            source: SceneSource::AssetPath {
                path: "/srv/assets/scenes/clock/default.json".to_string(),
            },
            metadata: BTreeMap::from([("theme".to_string(), "dark".to_string())]),
        };

        let serialized = serde_json::to_string(&scene).expect("scene descriptor should serialize");
        assert!(serialized.contains("\"type\":\"asset_path\""));
    }

    #[test]
    fn deserializes_frame_state_from_json() {
        let payload = r#"{
            "frame_id": "kitchen-display",
            "status": "rendering",
            "active_scene": "clock/default",
            "width": 1920,
            "height": 1080,
            "rotated": 0,
            "last_error": null
        }"#;

        let state: FrameState = serde_json::from_str(payload).expect("frame state should deserialize");
        assert_eq!(state.status, FrameStatus::Rendering);
        assert_eq!(state.active_scene.as_deref(), Some("clock/default"));
    }
}
