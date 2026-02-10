use std::env;

use frameos::config::FrameOSConfig;
use frameos::interfaces::{command_contract_json, Cli, Command};
use frameos::logging;
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
        Command::Check => match build_runtime(&cli) {
            Ok(runtime) => {
                runtime.check();
                println!("FrameOS check: passed 🎉");
                return Ok(());
            }
            Err(error) => {
                logging::log_event(serde_json::json!({
                    "event": "runtime:check_failed",
                    "error": error.to_string(),
                }));
                return Err(error.into());
            }
        },
        Command::Run => {}
    }

    let runtime = build_runtime(&cli)?;
    logging::debug("FrameOS runtime prepared.");
    runtime.start()?;
    Ok(())
}
