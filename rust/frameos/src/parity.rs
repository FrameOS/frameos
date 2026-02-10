use serde::Deserialize;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RendererContract {
    pub api_version: String,
    pub supports_layers: bool,
    pub supported_color_formats: Vec<String>,
    pub max_fps: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DriverContract {
    pub api_version: String,
    pub device_kind: String,
    pub required_renderer_formats: Vec<String>,
    pub supports_partial_refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParityReport {
    pub renderer_api_version: String,
    pub driver_api_version: String,
    pub shared_formats: Vec<String>,
    pub driver_device_kind: String,
}

#[derive(Debug)]
pub enum ParityError {
    ReadFailed(PathBuf, io::Error),
    ParseFailed(PathBuf, serde_json::Error),
    ValidationFailed(Vec<String>),
}

impl fmt::Display for ParityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReadFailed(path, err) => {
                write!(
                    f,
                    "failed to read parity contract {}: {}",
                    path.display(),
                    err
                )
            }
            Self::ParseFailed(path, err) => {
                write!(
                    f,
                    "failed to parse parity contract {}: {}",
                    path.display(),
                    err
                )
            }
            Self::ValidationFailed(messages) => {
                write!(f, "parity validation failed: {}", messages.join("; "))
            }
        }
    }
}

impl std::error::Error for ParityError {}

pub fn load_renderer_contract(path: impl AsRef<Path>) -> Result<RendererContract, ParityError> {
    let path = path.as_ref();
    let contents = fs::read_to_string(path)
        .map_err(|error| ParityError::ReadFailed(path.to_path_buf(), error))?;
    serde_json::from_str::<RendererContract>(&contents)
        .map_err(|error| ParityError::ParseFailed(path.to_path_buf(), error))
}

pub fn load_driver_contract(path: impl AsRef<Path>) -> Result<DriverContract, ParityError> {
    let path = path.as_ref();
    let contents = fs::read_to_string(path)
        .map_err(|error| ParityError::ReadFailed(path.to_path_buf(), error))?;
    serde_json::from_str::<DriverContract>(&contents)
        .map_err(|error| ParityError::ParseFailed(path.to_path_buf(), error))
}

pub fn validate_renderer_driver_parity(
    renderer: &RendererContract,
    driver: &DriverContract,
) -> Result<ParityReport, ParityError> {
    let mut errors = Vec::new();

    if renderer.api_version.trim().is_empty() {
        errors.push("renderer api_version must not be empty".to_string());
    }
    if driver.api_version.trim().is_empty() {
        errors.push("driver api_version must not be empty".to_string());
    }
    if renderer.api_version != driver.api_version {
        errors.push(format!(
            "api version mismatch (renderer={}, driver={})",
            renderer.api_version, driver.api_version
        ));
    }

    if renderer.supported_color_formats.is_empty() {
        errors.push("renderer supported_color_formats must not be empty".to_string());
    }
    if driver.required_renderer_formats.is_empty() {
        errors.push("driver required_renderer_formats must not be empty".to_string());
    }

    let missing_formats: Vec<String> = driver
        .required_renderer_formats
        .iter()
        .filter(|format| !renderer.supported_color_formats.contains(format))
        .cloned()
        .collect();
    if !missing_formats.is_empty() {
        errors.push(format!(
            "renderer missing required driver formats: {}",
            missing_formats.join(", ")
        ));
    }

    if driver.supports_partial_refresh && !matches!(driver.device_kind.as_str(), "eink" | "epd") {
        errors.push(format!(
            "partial refresh is only allowed for eink/epd device kinds (got {})",
            driver.device_kind
        ));
    }

    if renderer.max_fps == 0 {
        errors.push("renderer max_fps must be greater than zero".to_string());
    }

    if !errors.is_empty() {
        return Err(ParityError::ValidationFailed(errors));
    }

    let mut shared_formats = renderer
        .supported_color_formats
        .iter()
        .filter(|format| driver.required_renderer_formats.contains(format))
        .cloned()
        .collect::<Vec<_>>();
    shared_formats.sort();
    shared_formats.dedup();

    Ok(ParityReport {
        renderer_api_version: renderer.api_version.clone(),
        driver_api_version: driver.api_version.clone(),
        shared_formats,
        driver_device_kind: driver.device_kind.clone(),
    })
}

pub fn run_parity_check(
    renderer_path: impl AsRef<Path>,
    driver_path: impl AsRef<Path>,
) -> Result<ParityReport, ParityError> {
    let renderer = load_renderer_contract(renderer_path)?;
    let driver = load_driver_contract(driver_path)?;
    validate_renderer_driver_parity(&renderer, &driver)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_matching_contracts() {
        let renderer = RendererContract {
            api_version: "v1".to_string(),
            supports_layers: true,
            supported_color_formats: vec!["rgb565".to_string(), "rgb888".to_string()],
            max_fps: 30,
        };
        let driver = DriverContract {
            api_version: "v1".to_string(),
            device_kind: "eink".to_string(),
            required_renderer_formats: vec!["rgb565".to_string()],
            supports_partial_refresh: true,
        };

        let report =
            validate_renderer_driver_parity(&renderer, &driver).expect("contracts should validate");
        assert_eq!(report.shared_formats, vec!["rgb565".to_string()]);
    }

    #[test]
    fn reports_multiple_validation_failures() {
        let renderer = RendererContract {
            api_version: "v1".to_string(),
            supports_layers: true,
            supported_color_formats: vec!["rgb565".to_string()],
            max_fps: 0,
        };
        let driver = DriverContract {
            api_version: "v2".to_string(),
            device_kind: "lcd".to_string(),
            required_renderer_formats: vec!["rgb888".to_string()],
            supports_partial_refresh: true,
        };

        let error = validate_renderer_driver_parity(&renderer, &driver)
            .expect_err("invalid contracts should return a validation error");

        let ParityError::ValidationFailed(messages) = error else {
            panic!("expected validation error");
        };
        assert!(messages
            .iter()
            .any(|message| message.contains("api version mismatch")));
        assert!(messages
            .iter()
            .any(|message| message.contains("missing required driver formats")));
        assert!(messages
            .iter()
            .any(|message| message.contains("partial refresh is only allowed")));
        assert!(messages
            .iter()
            .any(|message| message.contains("max_fps must be greater than zero")));
    }
}
