use serde::de::DeserializeOwned;
use sha1::{Digest, Sha1};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoverySource {
    File(PathBuf),
    InlineJson(String),
}

impl DiscoverySource {
    pub fn source_kind(&self) -> &'static str {
        "discovered"
    }

    pub fn source_label(&self) -> String {
        match self {
            Self::File(path) => format!("discovery-file:{}", path.display()),
            Self::InlineJson(json) => {
                let mut hasher = Sha1::new();
                hasher.update(json.as_bytes());
                let digest = format!("{:x}", hasher.finalize());
                format!("discovery-inline:sha1:{}:len:{}", &digest[..12], json.len())
            }
        }
    }
}

#[derive(Debug)]
pub enum DiscoveryError {
    ReadFailed(PathBuf, io::Error),
    ParseFailed(String, serde_json::Error),
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReadFailed(path, err) => {
                write!(
                    f,
                    "failed to read discovery payload {}: {}",
                    path.display(),
                    err
                )
            }
            Self::ParseFailed(source, err) => {
                write!(f, "failed to parse discovery payload {}: {}", source, err)
            }
        }
    }
}

impl std::error::Error for DiscoveryError {}

pub fn load_discovered_contract<T>(source: &DiscoverySource) -> Result<T, DiscoveryError>
where
    T: DeserializeOwned,
{
    match source {
        DiscoverySource::File(path) => {
            let contents = fs::read_to_string(path)
                .map_err(|error| DiscoveryError::ReadFailed(path.to_path_buf(), error))?;
            serde_json::from_str::<T>(&contents)
                .map_err(|error| DiscoveryError::ParseFailed(path.display().to_string(), error))
        }
        DiscoverySource::InlineJson(json) => serde_json::from_str::<T>(json)
            .map_err(|error| DiscoveryError::ParseFailed("inline-json".to_string(), error)),
    }
}

pub fn discovery_source_from_cli(
    file: Option<&Path>,
    inline_json: Option<&str>,
    file_flag: &str,
    inline_flag: &str,
) -> Result<DiscoverySource, io::Error> {
    match (file, inline_json) {
        (Some(path), None) => Ok(DiscoverySource::File(path.to_path_buf())),
        (None, Some(raw)) => Ok(DiscoverySource::InlineJson(raw.to_string())),
        (Some(_), Some(_)) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{file_flag} and {inline_flag} are mutually exclusive"),
        )),
        (None, None) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("one of {file_flag} or {inline_flag} is required"),
        )),
    }
}
