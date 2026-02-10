use crate::config::FrameOSConfig;

/// Server runtime placeholder.
#[derive(Debug, Clone)]
pub struct Server {
    host: String,
    port: u16,
}

impl Server {
    pub fn from_config(config: &FrameOSConfig) -> Self {
        Self {
            host: config.server_host.clone(),
            port: config.server_port,
        }
    }

    pub fn endpoint(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}
