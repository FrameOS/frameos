use crate::config::FrameOSConfig;
use std::io;

/// Core runtime handle for FrameOS.
#[derive(Debug)]
pub struct Runtime {
    config: FrameOSConfig,
}

impl Runtime {
    pub fn new(config: FrameOSConfig) -> Self {
        Self { config }
    }

    pub fn start(&self) -> io::Result<()> {
        println!(
            "FrameOS runtime stub: data_dir={}, state_dir={}",
            self.config.data_dir.display(),
            self.config.state_dir.display()
        );
        Ok(())
    }
}
