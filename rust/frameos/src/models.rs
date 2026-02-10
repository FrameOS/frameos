use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelValidationError {
    MissingField(&'static str),
    InvalidField { field: &'static str, reason: String },
}

impl fmt::Display for ModelValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingField(field) => write!(f, "missing required field: {field}"),
            Self::InvalidField { field, reason } => {
                write!(f, "invalid field `{field}`: {reason}")
            }
        }
    }
}

impl std::error::Error for ModelValidationError {}

fn is_semver_like(value: &str) -> bool {
    let mut segments = value.split('.');
    let Some(major) = segments.next() else {
        return false;
    };
    let Some(minor) = segments.next() else {
        return false;
    };
    let Some(patch) = segments.next() else {
        return false;
    };

    if segments.next().is_some() {
        return false;
    }

    [major, minor, patch].into_iter().all(|segment| {
        !segment.is_empty() && segment.chars().all(|character| character.is_ascii_digit())
    })
}

impl SceneDescriptor {
    pub fn validate(&self) -> Result<(), ModelValidationError> {
        if self.id.trim().is_empty() {
            return Err(ModelValidationError::MissingField("id"));
        }
        if self.app_id.trim().is_empty() {
            return Err(ModelValidationError::MissingField("app_id"));
        }
        if self.version.trim().is_empty() {
            return Err(ModelValidationError::MissingField("version"));
        }
        if !is_semver_like(&self.version) {
            return Err(ModelValidationError::InvalidField {
                field: "version",
                reason: "must match major.minor.patch using numeric segments".to_string(),
            });
        }

        match &self.source {
            SceneSource::AssetPath { path } => {
                if path.trim().is_empty() {
                    return Err(ModelValidationError::MissingField("source.path"));
                }
                if !path.starts_with('/') {
                    return Err(ModelValidationError::InvalidField {
                        field: "source.path",
                        reason: "asset path must be absolute".to_string(),
                    });
                }
            }
            SceneSource::InlineJson => {}
            SceneSource::RemoteUrl { url } => {
                if url.trim().is_empty() {
                    return Err(ModelValidationError::MissingField("source.url"));
                }
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err(ModelValidationError::InvalidField {
                        field: "source.url",
                        reason: "remote url must start with http:// or https://".to_string(),
                    });
                }
            }
        }

        Ok(())
    }
}

impl AppDescriptor {
    pub fn validate(&self) -> Result<(), ModelValidationError> {
        if self.id.trim().is_empty() {
            return Err(ModelValidationError::MissingField("id"));
        }
        if self.display_name.trim().is_empty() {
            return Err(ModelValidationError::MissingField("display_name"));
        }
        if self.executable.trim().is_empty() {
            return Err(ModelValidationError::MissingField("executable"));
        }
        if let Some(entry_scene) = &self.entry_scene {
            if entry_scene.trim().is_empty() {
                return Err(ModelValidationError::InvalidField {
                    field: "entry_scene",
                    reason: "entry scene cannot be blank when provided".to_string(),
                });
            }
        }
        if self.env.keys().any(|key| key.trim().is_empty()) {
            return Err(ModelValidationError::InvalidField {
                field: "env",
                reason: "environment variable keys cannot be blank".to_string(),
            });
        }

        Ok(())
    }
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

        let state: FrameState =
            serde_json::from_str(payload).expect("frame state should deserialize");
        assert_eq!(state.status, FrameStatus::Rendering);
        assert_eq!(state.active_scene.as_deref(), Some("clock/default"));
    }

    #[test]
    fn rejects_invalid_scene_version() {
        let scene = SceneDescriptor {
            id: "clock/default".to_string(),
            app_id: "clock".to_string(),
            version: "v1".to_string(),
            source: SceneSource::InlineJson,
            metadata: BTreeMap::new(),
        };

        assert!(matches!(
            scene.validate(),
            Err(ModelValidationError::InvalidField {
                field: "version",
                ..
            })
        ));
    }

    #[test]
    fn rejects_empty_app_descriptor_display_name() {
        let app = AppDescriptor {
            id: "clock".to_string(),
            display_name: "".to_string(),
            executable: "/usr/bin/frameos-clock".to_string(),
            entry_scene: Some("clock/default".to_string()),
            enabled: true,
            env: BTreeMap::new(),
        };

        assert_eq!(
            app.validate(),
            Err(ModelValidationError::MissingField("display_name"))
        );
    }
}
