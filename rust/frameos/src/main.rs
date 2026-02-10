use std::env;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use frameos::config::FrameOSConfig;
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
    probe_cmd: Option<&str>,
    path_flag: &str,
    probe_flag: &str,
) -> Result<ContractSource, io::Error> {
    match (path, probe_cmd) {
        (Some(path), None) => Ok(ContractSource::FixtureFile(path.to_path_buf())),
        (None, Some(command)) => Ok(ContractSource::ProbeCommand(command.to_string())),
        (Some(_), Some(_)) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{path_flag} and {probe_flag} are mutually exclusive"),
        )),
        (None, None) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("one of {path_flag} or {probe_flag} is required"),
        )),
    }
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
                cli.renderer_probe_cmd.as_deref(),
                "--renderer-contract <path>",
                "--renderer-probe-cmd <shell command>",
            )?;
            let driver_source = parity_contract_source(
                cli.driver_contract_path.as_deref(),
                cli.driver_probe_cmd.as_deref(),
                "--driver-contract <path>",
                "--driver-probe-cmd <shell command>",
            )?;

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
                        }),
                    );
                    return Err(error.into());
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
