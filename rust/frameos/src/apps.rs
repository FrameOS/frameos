use crate::models::AppDescriptor;

/// In-memory application registry placeholder.
#[derive(Debug, Default)]
pub struct AppRegistry {
    apps: Vec<AppDescriptor>,
}

impl AppRegistry {
    pub fn with_apps(apps: Vec<AppDescriptor>) -> Self {
        Self { apps }
    }

    pub fn apps(&self) -> &[AppDescriptor] {
        &self.apps
    }
}
