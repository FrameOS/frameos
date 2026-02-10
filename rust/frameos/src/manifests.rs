use crate::apps::AppRegistry;
use crate::models::{AppDescriptor, ModelValidationError, SceneDescriptor};
use crate::scenes::SceneCatalog;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum ManifestLoadError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    Validation {
        manifest: &'static str,
        index: usize,
        source: ModelValidationError,
    },
}

impl fmt::Display for ManifestLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => {
                write!(f, "failed to read manifest {}: {source}", path.display())
            }
            Self::Parse { path, source } => {
                write!(f, "failed to parse manifest {}: {source}", path.display())
            }
            Self::Validation {
                manifest,
                index,
                source,
            } => {
                write!(f, "invalid {manifest} entry at index {index}: {source}")
            }
        }
    }
}

impl std::error::Error for ManifestLoadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::Validation { source, .. } => Some(source),
        }
    }
}

fn read_manifest(path: &Path) -> Result<String, ManifestLoadError> {
    fs::read_to_string(path).map_err(|source| ManifestLoadError::Io {
        path: path.to_path_buf(),
        source,
    })
}

pub fn load_scene_manifest(
    path: impl AsRef<Path>,
) -> Result<Vec<SceneDescriptor>, ManifestLoadError> {
    let path = path.as_ref();
    let payload = read_manifest(path)?;
    let scenes: Vec<SceneDescriptor> =
        serde_json::from_str(&payload).map_err(|source| ManifestLoadError::Parse {
            path: path.to_path_buf(),
            source,
        })?;

    for (index, scene) in scenes.iter().enumerate() {
        scene
            .validate()
            .map_err(|source| ManifestLoadError::Validation {
                manifest: "scene",
                index,
                source,
            })?;
    }

    Ok(scenes)
}

pub fn load_app_manifest(path: impl AsRef<Path>) -> Result<Vec<AppDescriptor>, ManifestLoadError> {
    let path = path.as_ref();
    let payload = read_manifest(path)?;
    let apps: Vec<AppDescriptor> =
        serde_json::from_str(&payload).map_err(|source| ManifestLoadError::Parse {
            path: path.to_path_buf(),
            source,
        })?;

    for (index, app) in apps.iter().enumerate() {
        app.validate()
            .map_err(|source| ManifestLoadError::Validation {
                manifest: "app",
                index,
                source,
            })?;
    }

    Ok(apps)
}

pub fn load_scene_catalog(path: impl AsRef<Path>) -> Result<SceneCatalog, ManifestLoadError> {
    let scenes = load_scene_manifest(path)?;
    Ok(SceneCatalog::with_scenes(scenes))
}

pub fn load_app_registry(path: impl AsRef<Path>) -> Result<AppRegistry, ManifestLoadError> {
    let apps = load_app_manifest(path)?;
    Ok(AppRegistry::with_apps(apps))
}
