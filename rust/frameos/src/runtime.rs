use crate::config::FrameOSConfig;
use crate::logging;
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
        logging::log_event(serde_json::json!({
            "event": "runtime:start",
            "config": {
                "name": self.config.name,
                "mode": self.config.mode,
                "server_host": self.config.server_host,
                "server_port": self.config.server_port,
                "frame_host": self.config.frame_host,
                "frame_port": self.config.frame_port,
                "width": self.config.width,
                "height": self.config.height,
                "device": self.config.device,
                "assets_path": self.config.assets_path,
            }
        }));
        Ok(())
    }
}
