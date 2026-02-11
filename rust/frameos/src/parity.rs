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
    pub scheduling: RendererSchedulingContract,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RendererSchedulingContract {
    pub target_fps: u32,
    pub tick_budget_ms: u32,
    pub drop_policy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DriverContract {
    pub api_version: String,
    pub device_kind: String,
    pub required_renderer_formats: Vec<String>,
    pub supports_partial_refresh: bool,
    pub scheduling: DriverSchedulingContract,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DriverSchedulingContract {
    pub backpressure_policy: String,
    pub max_queue_depth: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractSource {
    FixtureFile(PathBuf),
    Discovery(crate::discovery::DiscoverySource),
}

impl ContractSource {
    pub fn source_kind(&self) -> &'static str {
        match self {
            Self::FixtureFile(_) => "fixture",
            Self::Discovery(_) => "discovered",
        }
    }

    pub fn source_label(&self) -> String {
        match self {
            Self::FixtureFile(path) => format!("fixture:{}", path.display()),
            Self::Discovery(source) => source.source_label(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParityReport {
    pub renderer_api_version: String,
    pub driver_api_version: String,
    pub shared_formats: Vec<String>,
    pub driver_device_kind: String,
    pub renderer_target_fps: u32,
    pub renderer_tick_budget_ms: u32,
    pub renderer_drop_policy: String,
    pub driver_backpressure_policy: String,
    pub driver_max_queue_depth: u32,
    pub renderer_contract_source: String,
    pub driver_contract_source: String,
}

#[derive(Debug)]
pub enum ParityError {
    ReadFailed(PathBuf, io::Error),
    ParseFailed(String, serde_json::Error),
    DiscoveryFailed(String),
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
            Self::ParseFailed(source, err) => {
                write!(f, "failed to parse parity contract {}: {}", source, err)
            }
            Self::DiscoveryFailed(details) => {
                write!(f, "failed to load discovered parity contract: {details}")
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
        .map_err(|error| ParityError::ParseFailed(path.display().to_string(), error))
}

pub fn load_driver_contract(path: impl AsRef<Path>) -> Result<DriverContract, ParityError> {
    let path = path.as_ref();
    let contents = fs::read_to_string(path)
        .map_err(|error| ParityError::ReadFailed(path.to_path_buf(), error))?;
    serde_json::from_str::<DriverContract>(&contents)
        .map_err(|error| ParityError::ParseFailed(path.display().to_string(), error))
}

pub fn load_renderer_contract_from_source(
    source: &ContractSource,
) -> Result<RendererContract, ParityError> {
    match source {
        ContractSource::FixtureFile(path) => load_renderer_contract(path),
        ContractSource::Discovery(source) => crate::discovery::load_discovered_contract(source)
            .map_err(|error| ParityError::DiscoveryFailed(error.to_string())),
    }
}

pub fn load_driver_contract_from_source(
    source: &ContractSource,
) -> Result<DriverContract, ParityError> {
    match source {
        ContractSource::FixtureFile(path) => load_driver_contract(path),
        ContractSource::Discovery(source) => crate::discovery::load_discovered_contract(source)
            .map_err(|error| ParityError::DiscoveryFailed(error.to_string())),
    }
}

pub fn validate_renderer_driver_parity(
    renderer: &RendererContract,
    driver: &DriverContract,
) -> Result<ParityReport, ParityError> {
    validate_renderer_driver_parity_with_sources(renderer, driver, "fixture", "fixture")
}

pub fn validate_renderer_driver_parity_with_sources(
    renderer: &RendererContract,
    driver: &DriverContract,
    renderer_source: &str,
    driver_source: &str,
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

    if renderer.scheduling.target_fps == 0 {
        errors.push("renderer scheduling.target_fps must be greater than zero".to_string());
    }

    if renderer.scheduling.tick_budget_ms == 0 {
        errors.push("renderer scheduling.tick_budget_ms must be greater than zero".to_string());
    }

    if renderer.scheduling.target_fps > renderer.max_fps {
        errors.push(format!(
            "renderer scheduling.target_fps ({}) must be <= max_fps ({})",
            renderer.scheduling.target_fps, renderer.max_fps
        ));
    }

    if renderer.scheduling.target_fps > 0 {
        let frame_budget_ms = (1000.0 / renderer.scheduling.target_fps as f64).floor() as u32;
        if renderer.scheduling.tick_budget_ms > frame_budget_ms {
            errors.push(format!(
                "renderer scheduling.tick_budget_ms ({}) exceeds frame budget at target_fps={} ({}ms)",
                renderer.scheduling.tick_budget_ms,
                renderer.scheduling.target_fps,
                frame_budget_ms
            ));
        }
    }

    if !matches!(
        renderer.scheduling.drop_policy.as_str(),
        "drop_oldest" | "drop_newest" | "block"
    ) {
        errors.push(format!(
            "renderer scheduling.drop_policy must be one of drop_oldest/drop_newest/block (got {})",
            renderer.scheduling.drop_policy
        ));
    }

    if !matches!(
        driver.scheduling.backpressure_policy.as_str(),
        "drop" | "queue" | "block"
    ) {
        errors.push(format!(
            "driver scheduling.backpressure_policy must be one of drop/queue/block (got {})",
            driver.scheduling.backpressure_policy
        ));
    }

    if driver.scheduling.backpressure_policy == "queue" && driver.scheduling.max_queue_depth == 0 {
        errors.push("driver scheduling.max_queue_depth must be greater than zero when backpressure_policy=queue".to_string());
    }

    if driver.scheduling.backpressure_policy != "queue" && driver.scheduling.max_queue_depth != 0 {
        errors.push(
            "driver scheduling.max_queue_depth must be zero unless backpressure_policy=queue"
                .to_string(),
        );
    }

    if driver.scheduling.backpressure_policy == "drop"
        && !renderer.scheduling.drop_policy.starts_with("drop_")
    {
        errors.push(
            "driver backpressure_policy=drop requires renderer drop_policy to be drop_oldest or drop_newest".to_string(),
        );
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
        renderer_target_fps: renderer.scheduling.target_fps,
        renderer_tick_budget_ms: renderer.scheduling.tick_budget_ms,
        renderer_drop_policy: renderer.scheduling.drop_policy.clone(),
        driver_backpressure_policy: driver.scheduling.backpressure_policy.clone(),
        driver_max_queue_depth: driver.scheduling.max_queue_depth,
        renderer_contract_source: renderer_source.to_string(),
        driver_contract_source: driver_source.to_string(),
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

pub fn run_parity_check_with_sources(
    renderer_source: &ContractSource,
    driver_source: &ContractSource,
) -> Result<ParityReport, ParityError> {
    let renderer = load_renderer_contract_from_source(renderer_source)?;
    let driver = load_driver_contract_from_source(driver_source)?;
    validate_renderer_driver_parity_with_sources(
        &renderer,
        &driver,
        renderer_source.source_kind(),
        driver_source.source_kind(),
    )
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
            scheduling: RendererSchedulingContract {
                target_fps: 20,
                tick_budget_ms: 25,
                drop_policy: "drop_oldest".to_string(),
            },
        };
        let driver = DriverContract {
            api_version: "v1".to_string(),
            device_kind: "eink".to_string(),
            required_renderer_formats: vec!["rgb565".to_string()],
            supports_partial_refresh: true,
            scheduling: DriverSchedulingContract {
                backpressure_policy: "drop".to_string(),
                max_queue_depth: 0,
            },
        };

        let report =
            validate_renderer_driver_parity(&renderer, &driver).expect("contracts should validate");
        assert_eq!(report.shared_formats, vec!["rgb565".to_string()]);
        assert_eq!(report.renderer_target_fps, 20);
        assert_eq!(report.renderer_contract_source, "fixture");
        assert_eq!(report.driver_contract_source, "fixture");
    }
}
