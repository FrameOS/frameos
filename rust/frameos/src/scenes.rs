use crate::models::SceneDescriptor;

/// In-memory scene catalog placeholder.
#[derive(Debug, Default)]
pub struct SceneCatalog {
    scenes: Vec<SceneDescriptor>,
}

impl SceneCatalog {
    pub fn with_scenes(scenes: Vec<SceneDescriptor>) -> Self {
        Self { scenes }
    }

    pub fn scenes(&self) -> &[SceneDescriptor] {
        &self.scenes
    }
}
