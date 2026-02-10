use serde::Deserialize;
use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// Configuration for the FrameOS runtime.
#[derive(Debug, Clone)]
pub struct FrameOSConfig {
    pub name: String,
    pub mode: String,
    pub server_host: String,
    pub server_port: u16,
    pub server_api_key: String,
    pub frame_host: String,
    pub frame_port: u16,
    pub frame_access: String,
    pub frame_access_key: String,
    pub width: u32,
    pub height: u32,
    pub device: String,
    pub metrics_interval_seconds: u64,
    pub rotate: i32,
    pub flip: String,
    pub scaling_mode: String,
    pub assets_path: PathBuf,
    pub log_to_file: Option<PathBuf>,
    pub debug: bool,
    pub time_zone: String,
}

#[derive(Debug)]
pub enum ConfigError {
    MissingConfig(PathBuf),
    ReadFailed(PathBuf, std::io::Error),
    ParseFailed(PathBuf, serde_json::Error),
    ValidationFailed(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingConfig(path) => {
                write!(formatter, "config file not found: {}", path.display())
            }
            Self::ReadFailed(path, err) => {
                write!(formatter, "failed to read config file {}: {}", path.display(), err)
            }
            Self::ParseFailed(path, err) => {
                write!(formatter, "failed to parse config file {}: {}", path.display(), err)
            }
            Self::ValidationFailed(message) => write!(formatter, "invalid config: {}", message),
        }
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawFrameOSConfig {
    name: Option<String>,
    mode: Option<String>,
    server_host: Option<String>,
    server_port: Option<u16>,
    server_api_key: Option<String>,
    frame_host: Option<String>,
    frame_port: Option<u16>,
    frame_access: Option<String>,
    frame_access_key: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    device: Option<String>,
    metrics_interval: Option<u64>,
    rotate: Option<i32>,
    flip: Option<String>,
    scaling_mode: Option<String>,
    assets_path: Option<PathBuf>,
    log_to_file: Option<PathBuf>,
    debug: Option<bool>,
    time_zone: Option<String>,
}

impl FrameOSConfig {
    pub fn config_path() -> PathBuf {
        env::var("FRAMEOS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./frame.json"))
    }

    pub fn load() -> Result<Self, ConfigError> {
        let path = Self::config_path();
        if !path.exists() {
            return Err(ConfigError::MissingConfig(path));
        }
        let contents = fs::read_to_string(&path).map_err(|err| ConfigError::ReadFailed(path.clone(), err))?;
        let raw: RawFrameOSConfig =
            serde_json::from_str(&contents).map_err(|err| ConfigError::ParseFailed(path.clone(), err))?;
        let mut config = FrameOSConfig::default();
        config.apply_raw(raw);
        config.validate()?;
        Ok(config)
    }

    fn apply_raw(&mut self, raw: RawFrameOSConfig) {
        if let Some(value) = raw.name {
            self.name = value;
        }
        if let Some(value) = raw.mode {
            self.mode = value;
        }
        if let Some(value) = raw.server_host {
            self.server_host = value;
        }
        if let Some(value) = raw.server_port {
            self.server_port = value;
        }
        if let Some(value) = raw.server_api_key {
            self.server_api_key = value;
        }
        if let Some(value) = raw.frame_host {
            self.frame_host = value;
        }
        if let Some(value) = raw.frame_port {
            self.frame_port = value;
        }
        if let Some(value) = raw.frame_access {
            self.frame_access = value;
        }
        if let Some(value) = raw.frame_access_key {
            self.frame_access_key = value;
        }
        if let Some(value) = raw.width {
            self.width = value;
        }
        if let Some(value) = raw.height {
            self.height = value;
        }
        if let Some(value) = raw.device {
            self.device = value;
        }
        if let Some(value) = raw.metrics_interval {
            self.metrics_interval_seconds = value;
        }
        if let Some(value) = raw.rotate {
            self.rotate = value;
        }
        if let Some(value) = raw.flip {
            self.flip = value;
        }
        if let Some(value) = raw.scaling_mode {
            self.scaling_mode = value;
        }
        if let Some(value) = raw.assets_path {
            self.assets_path = value;
        }
        if let Some(value) = raw.log_to_file {
            self.log_to_file = Some(value);
        }
        if let Some(value) = raw.debug {
            self.debug = value;
        }
        if let Some(value) = raw.time_zone {
            self.time_zone = value;
        }

        if self.name.is_empty() {
            self.name = self.frame_host.clone();
        }
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.width == 0 || self.height == 0 {
            return Err(ConfigError::ValidationFailed(
                "width and height must be positive".to_string(),
            ));
        }
        if self.server_port == 0 || self.frame_port == 0 {
            return Err(ConfigError::ValidationFailed(
                "server_port and frame_port must be positive".to_string(),
            ));
        }
        if !self.assets_path.is_absolute() {
            return Err(ConfigError::ValidationFailed(
                "assets_path must be an absolute path".to_string(),
            ));
        }
        Ok(())
    }
}

impl Default for FrameOSConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            mode: "rpios".to_string(),
            server_host: String::new(),
            server_port: 8989,
            server_api_key: String::new(),
            frame_host: "localhost".to_string(),
            frame_port: 8787,
            frame_access: "private".to_string(),
            frame_access_key: String::new(),
            width: 1920,
            height: 1080,
            device: "web_only".to_string(),
            metrics_interval_seconds: 60,
            rotate: 0,
            flip: String::new(),
            scaling_mode: "cover".to_string(),
            assets_path: Path::new("/srv/assets").to_path_buf(),
            log_to_file: None,
            debug: false,
            time_zone: "UTC".to_string(),
        }
    }
}
