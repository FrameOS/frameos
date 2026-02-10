use std::env;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use frameos::config::FrameOSConfig;
use frameos::interfaces::{command_contract_json, Cli, Command};
use frameos::logging::{
    self, FileJsonLineSink, JsonLineSink, MultiJsonLineSink, StdoutJsonLineSink,
};
use frameos::runtime::{Runtime, RuntimeError};

fn build_runtime(cli: &Cli) -> Result<Runtime, RuntimeError> {
    let config = FrameOSConfig::load_with_override(cli.config_path.as_deref())
        .map_err(RuntimeError::Config)?;
    let mut runtime = Runtime::new(config);

    if let Some(path) = &cli.scene_manifest {
        runtime = runtime.with_scene_manifest(path)?;
    }
    if let Some(path) = &cli.app_manifest {
        runtime = runtime.with_app_manifest(path)?;
    }

    Ok(runtime)
}

fn build_sink(cli: &Cli) -> Result<Arc<dyn JsonLineSink>, RuntimeError> {
    if let Some(path) = &cli.event_log_path {
        let stdout_sink = Arc::new(StdoutJsonLineSink) as Arc<dyn JsonLineSink>;
        let file_sink = Arc::new(FileJsonLineSink::append(path).map_err(RuntimeError::Io)?)
            as Arc<dyn JsonLineSink>;
        Ok(Arc::new(MultiJsonLineSink::new(vec![stdout_sink, file_sink])) as Arc<dyn JsonLineSink>)
    } else {
        Ok(Arc::new(StdoutJsonLineSink) as Arc<dyn JsonLineSink>)
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
            let sink = build_sink(&cli)?;
            match build_runtime(&cli) {
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
        Command::Run => {}
    }

    let runtime = build_runtime(&cli)?;
    let sink = build_sink(&cli)?;
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
