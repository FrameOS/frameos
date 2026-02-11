use std::env;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use frameos::config::FrameOSConfig;
use frameos::discovery::discovery_source_from_cli;
use frameos::e2e_cli::{default_e2e_options, run_e2e_snapshot_parity};
use frameos::interfaces::{command_contract_json, Cli, Command};
use frameos::logging::{
    self, FileJsonLineSink, JsonLineSink, MultiJsonLineSink, StdoutJsonLineSink,
};
use frameos::parity::{run_parity_check_with_sources, ContractSource};
use frameos::runtime::{Runtime, RuntimeError};

fn build_runtime(cli: &Cli, config: FrameOSConfig) -> Result<Runtime, RuntimeError> {
    let mut runtime = Runtime::new(config);

    if let Some(path) = &cli.scene_manifest {
        runtime = runtime.with_scene_manifest(path)?;
    }
    if let Some(path) = &cli.app_manifest {
        runtime = runtime.with_app_manifest(path)?;
    }

    Ok(runtime)
}

fn build_sink_with_optional_config(
    event_log_path: Option<&Path>,
    config: Option<&FrameOSConfig>,
) -> Result<Arc<dyn JsonLineSink>, RuntimeError> {
    let event_log_path = event_log_path.or(config.and_then(|loaded| loaded.log_to_file.as_deref()));
    if let Some(path) = event_log_path {
        let stdout_sink = Arc::new(StdoutJsonLineSink) as Arc<dyn JsonLineSink>;
        let file_sink = Arc::new(FileJsonLineSink::append(path).map_err(RuntimeError::Io)?)
            as Arc<dyn JsonLineSink>;
        Ok(Arc::new(MultiJsonLineSink::new(vec![stdout_sink, file_sink])) as Arc<dyn JsonLineSink>)
    } else {
        Ok(Arc::new(StdoutJsonLineSink) as Arc<dyn JsonLineSink>)
    }
}

fn parity_contract_source(
    path: Option<&Path>,
    discovery_file: Option<&Path>,
    discovery_json: Option<&str>,
    path_flag: &str,
    discovery_file_flag: &str,
    discovery_json_flag: &str,
) -> Result<ContractSource, io::Error> {
    if path.is_some() && (discovery_file.is_some() || discovery_json.is_some()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{path_flag} is mutually exclusive with discovery flags"),
        ));
    }

    if let Some(path) = path {
        return Ok(ContractSource::FixtureFile(path.to_path_buf()));
    }

    discovery_source_from_cli(
        discovery_file,
        discovery_json,
        discovery_file_flag,
        discovery_json_flag,
    )
    .map(ContractSource::Discovery)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse(env::args().skip(1).collect::<Vec<_>>())?;

    match cli.command {
        Command::PrintContract => {
            println!(
                "{}",
                serde_json::to_string_pretty(&command_contract_json())?
            );
            return Ok(());
        }
        Command::Check => {
            let config = FrameOSConfig::load_with_override(cli.config_path.as_deref())
                .map_err(RuntimeError::Config)?;
            let sink =
                build_sink_with_optional_config(cli.event_log_path.as_deref(), Some(&config))?;
            match build_runtime(&cli, config) {
                Ok(runtime) => {
                    runtime.check_with_sink(sink.as_ref());
                    println!("FrameOS check: passed 🎉");
                    return Ok(());
                }
                Err(error) => {
                    let _ = logging::log_event_with_sink(
                        sink.as_ref(),
                        serde_json::json!({
                            "event": "runtime:check_failed",
                            "error": error.to_string(),
                        }),
                    );
                    return Err(error.into());
                }
            }
        }
        Command::Parity => {
            let sink = build_sink_with_optional_config(cli.event_log_path.as_deref(), None)?;
            let renderer_source = parity_contract_source(
                cli.renderer_contract_path.as_deref(),
                cli.renderer_discovery_file.as_deref(),
                cli.renderer_discovery_json.as_deref(),
                "--renderer-contract <path>",
                "--renderer-discovery-file <path>",
                "--renderer-discovery-json <json>",
            )?;
            let driver_source = parity_contract_source(
                cli.driver_contract_path.as_deref(),
                cli.driver_discovery_file.as_deref(),
                cli.driver_discovery_json.as_deref(),
                "--driver-contract <path>",
                "--driver-discovery-file <path>",
                "--driver-discovery-json <json>",
            )?;
            let parity_started_at = Instant::now();
            let renderer_source_kind = renderer_source.source_kind();
            let driver_source_kind = driver_source.source_kind();
            let renderer_source_label = renderer_source.source_label();
            let driver_source_label = driver_source.source_label();

            match run_parity_check_with_sources(&renderer_source, &driver_source) {
                Ok(report) => {
                    let _ = logging::log_event_with_sink(
                        sink.as_ref(),
                        serde_json::json!({
                            "event": "runtime:parity_ok",
                            "renderer_api_version": report.renderer_api_version,
                            "driver_api_version": report.driver_api_version,
                            "driver_device_kind": report.driver_device_kind,
                            "shared_formats": report.shared_formats,
                            "renderer_target_fps": report.renderer_target_fps,
                            "renderer_tick_budget_ms": report.renderer_tick_budget_ms,
                            "renderer_drop_policy": report.renderer_drop_policy,
                            "driver_backpressure_policy": report.driver_backpressure_policy,
                            "driver_max_queue_depth": report.driver_max_queue_depth,
                            "renderer_contract_source": report.renderer_contract_source,
                            "driver_contract_source": report.driver_contract_source,
                        }),
                    );
                    println!("FrameOS parity check: passed 🎉");
                    return Ok(());
                }
                Err(error) => {
                    let _ = logging::log_event_with_sink(
                        sink.as_ref(),
                        serde_json::json!({
                            "event": "runtime:parity_failed",
                            "error": error.to_string(),
                            "duration_ms": parity_started_at.elapsed().as_millis(),
                            "renderer_contract_source": renderer_source_kind,
                            "driver_contract_source": driver_source_kind,
                            "renderer_source_label": renderer_source_label,
                            "driver_source_label": driver_source_label,
                        }),
                    );
                    return Err(error.into());
                }
            }
        }
        Command::E2e => {
            let sink = build_sink_with_optional_config(cli.event_log_path.as_deref(), None)?;
            let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let mut opts = default_e2e_options(&repo_root);
            if let Some(path) = &cli.e2e_scenes_dir {
                opts.scenes_dir = path.clone();
            }
            if let Some(path) = &cli.e2e_snapshots_dir {
                opts.snapshots_dir = path.clone();
            }
            if let Some(path) = &cli.e2e_assets_dir {
                opts.assets_dir = path.clone();
            }
            if let Some(path) = &cli.e2e_output_dir {
                opts.output_dir = path.clone();
            }

            match run_e2e_snapshot_parity(&opts) {
                Ok(report) if report.passed() => {
                    let _ = logging::log_event_with_sink(
                        sink.as_ref(),
                        serde_json::json!({
                            "event": "runtime:e2e_ok",
                            "scenes_checked": report.checked,
                            "scenes_failed": 0,
                            "max_diff": report.max_diff,
                        }),
                    );
                    println!(
                        "FrameOS e2e snapshot parity: passed 🎉 ({} scenes)",
                        report.checked
                    );
                    return Ok(());
                }
                Ok(report) => {
                    let failing_scenes: Vec<String> = report
                        .failed
                        .iter()
                        .map(|item| {
                            format!("{}:{:.4}>{:.2}", item.scene, item.diff, item.threshold)
                        })
                        .collect();
                    let _ = logging::log_event_with_sink(
                        sink.as_ref(),
                        serde_json::json!({
                            "event": "runtime:e2e_failed",
                            "scenes_checked": report.checked,
                            "scenes_failed": report.failed.len(),
                            "max_diff": report.max_diff,
                            "failing_scenes": failing_scenes,
                        }),
                    );
                    return Err(io::Error::new(
                        io::ErrorKind::Other,
                        format!(
                            "e2e snapshot parity failed for {} scenes",
                            report.failed.len()
                        ),
                    )
                    .into());
                }
                Err(error) => {
                    let _ = logging::log_event_with_sink(
                        sink.as_ref(),
                        serde_json::json!({
                            "event": "runtime:e2e_failed",
                            "scenes_checked": 0,
                            "scenes_failed": 0,
                            "max_diff": 0.0,
                            "failing_scenes": [],
                            "error": error,
                        }),
                    );
                    return Err(io::Error::new(io::ErrorKind::Other, error).into());
                }
            }
        }
        Command::Run => {}
    }

    let config = FrameOSConfig::load_with_override(cli.config_path.as_deref())
        .map_err(RuntimeError::Config)?;
    let sink = build_sink_with_optional_config(cli.event_log_path.as_deref(), Some(&config))?;
    let runtime = build_runtime(&cli, config)?;
    logging::debug("FrameOS runtime prepared.");

    let shutdown = Arc::new(AtomicBool::new(false));
    let signal_shutdown = Arc::clone(&shutdown);
    ctrlc::set_handler(move || {
        signal_shutdown.store(true, Ordering::SeqCst);
    })
    .map_err(|error| {
        io::Error::new(
            io::ErrorKind::Other,
            format!("failed to register ctrl-c handler: {error}"),
        )
    })?;

    runtime.run_until_stopped_with_sink(shutdown, sink.as_ref())?;
    Ok(())
}
