use std::path::PathBuf;

/// Configuration for the FrameOS runtime.
#[derive(Debug, Clone)]
pub struct FrameOSConfig {
    pub data_dir: PathBuf,
    pub state_dir: PathBuf,
}

impl Default for FrameOSConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("/opt/frameos"),
            state_dir: PathBuf::from("/var/lib/frameos"),
        }
    }
}
