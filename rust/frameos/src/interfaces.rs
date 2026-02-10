use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Run,
    Check,
    Parity,
    PrintContract,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub command: Command,
    pub config_path: Option<PathBuf>,
    pub scene_manifest: Option<PathBuf>,
    pub app_manifest: Option<PathBuf>,
    pub renderer_contract_path: Option<PathBuf>,
    pub driver_contract_path: Option<PathBuf>,
    pub renderer_probe_cmd: Option<String>,
    pub driver_probe_cmd: Option<String>,
    pub event_log_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliParseError {
    UnknownArgument(String),
    MissingValue(&'static str),
    UnknownCommand(String),
}

impl std::fmt::Display for CliParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownArgument(argument) => write!(f, "unknown argument: {argument}"),
            Self::MissingValue(flag) => write!(f, "missing value for {flag}"),
            Self::UnknownCommand(command) => write!(f, "unknown command: {command}"),
        }
    }
}

impl std::error::Error for CliParseError {}

impl Default for Cli {
    fn default() -> Self {
        Self {
            command: Command::Run,
            config_path: None,
            scene_manifest: None,
            app_manifest: None,
            renderer_contract_path: None,
            driver_contract_path: None,
            renderer_probe_cmd: None,
            driver_probe_cmd: None,
            event_log_path: None,
        }
    }
}

impl Cli {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, CliParseError> {
        let mut cli = Cli::default();
        let mut iter = args.into_iter().peekable();

        if let Some(candidate) = iter.peek() {
            match candidate.as_str() {
                "run" => {
                    cli.command = Command::Run;
                    iter.next();
                }
                "check" => {
                    cli.command = Command::Check;
                    iter.next();
                }
                "parity" => {
                    cli.command = Command::Parity;
                    iter.next();
                }
                "contract" => {
                    cli.command = Command::PrintContract;
                    iter.next();
                }
                option if option.starts_with('-') => {}
                _ => return Err(CliParseError::UnknownCommand(candidate.clone())),
            }
        }

        while let Some(argument) = iter.next() {
            match argument.as_str() {
                "--config" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--config"));
                    };
                    cli.config_path = Some(PathBuf::from(value));
                }
                "--scenes" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--scenes"));
                    };
                    cli.scene_manifest = Some(PathBuf::from(value));
                }
                "--apps" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--apps"));
                    };
                    cli.app_manifest = Some(PathBuf::from(value));
                }
                "--renderer-contract" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--renderer-contract"));
                    };
                    cli.renderer_contract_path = Some(PathBuf::from(value));
                }
                "--driver-contract" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--driver-contract"));
                    };
                    cli.driver_contract_path = Some(PathBuf::from(value));
                }
                "--renderer-probe-cmd" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--renderer-probe-cmd"));
                    };
                    cli.renderer_probe_cmd = Some(value);
                }
                "--driver-probe-cmd" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--driver-probe-cmd"));
                    };
                    cli.driver_probe_cmd = Some(value);
                }
                "--event-log" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--event-log"));
                    };
                    cli.event_log_path = Some(PathBuf::from(value));
                }
                _ => return Err(CliParseError::UnknownArgument(argument)),
            }
        }

        Ok(cli)
    }
}

pub fn command_contract_json() -> serde_json::Value {
    serde_json::json!({
        "commands": {
            "run": {
                "description": "Boot FrameOS runtime and optionally preload manifests.",
                "flags": ["--config <path>", "--scenes <path>", "--apps <path>", "--event-log <path>"],
                "event_log_routing": "--event-log overrides config.log_to_file when both are set"
            },
            "check": {
                "description": "Validate that config and optional manifests can be loaded.",
                "flags": ["--config <path>", "--scenes <path>", "--apps <path>", "--event-log <path>"],
                "event_log_routing": "--event-log overrides config.log_to_file when both are set"
            },
            "parity": {
                "description": "Validate renderer/driver contracts against parity invariants (fixture files or discovery probe commands).",
                "flags": ["--renderer-contract <path>", "--driver-contract <path>", "--renderer-probe-cmd <shell command>", "--driver-probe-cmd <shell command>", "--event-log <path>"],
                "notes": "provide exactly one source per side: contract path or probe command"
            },
            "contract": {
                "description": "Print the runtime CLI/event contract as JSON.",
                "flags": []
            }
        },
        "event_stream": {
            "transport": "websocket",
            "path": "/ws/events",
            "message_envelope": {
                "event": "string",
                "timestamp": "number",
                "fields": "object"
            }
        },
        "events": {
            "runtime:start": {"level": "info", "fields": ["server", "apps_loaded", "scenes_loaded", "config"]},
            "runtime:ready": {"level": "info", "fields": ["server", "health_endpoint", "event_stream_transport", "metrics_interval_seconds", "apps_loaded", "scenes_loaded"]},
            "runtime:stop": {"level": "info", "fields": ["server", "metrics_interval_seconds", "apps_loaded", "scenes_loaded"]},
            "runtime:check_ok": {"level": "info", "fields": ["server", "metrics_interval_seconds", "apps_loaded", "scenes_loaded"]},
            "runtime:check_failed": {"level": "error", "fields": ["error"]},
            "runtime:parity_ok": {"level": "info", "fields": ["renderer_api_version", "driver_api_version", "driver_device_kind", "shared_formats", "renderer_target_fps", "renderer_tick_budget_ms", "renderer_drop_policy", "driver_backpressure_policy", "driver_max_queue_depth", "renderer_contract_source", "driver_contract_source"]},
            "runtime:parity_failed": {"level": "error", "fields": ["error"]},
            "runtime:heartbeat": {"level": "debug", "fields": ["uptime_seconds", "server"]},
            "runtime:metrics_tick": {"level": "info", "fields": ["uptime_seconds", "metrics_interval_seconds", "apps_loaded", "scenes_loaded"]}
        },
        "command_event_fields": {
            "run": {
                "runtime:start": ["server", "apps_loaded", "scenes_loaded", "config"],
                "runtime:ready": ["server", "health_endpoint", "event_stream_transport", "metrics_interval_seconds", "apps_loaded", "scenes_loaded"],
                "runtime:heartbeat": ["uptime_seconds", "server"],
                "runtime:metrics_tick": ["uptime_seconds", "metrics_interval_seconds", "apps_loaded", "scenes_loaded"],
                "runtime:stop": ["server", "metrics_interval_seconds", "apps_loaded", "scenes_loaded"]
            },
            "check": {
                "runtime:check_ok": ["server", "metrics_interval_seconds", "apps_loaded", "scenes_loaded"],
                "runtime:check_failed": ["error"]
            },
            "parity": {
                "runtime:parity_ok": ["renderer_api_version", "driver_api_version", "driver_device_kind", "shared_formats", "renderer_target_fps", "renderer_tick_budget_ms", "renderer_drop_policy", "driver_backpressure_policy", "driver_max_queue_depth", "renderer_contract_source", "driver_contract_source"],
                "runtime:parity_failed": ["error"]
            },
            "contract": {}
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_check_command_and_flags() {
        let cli = Cli::parse(vec![
            "check".to_string(),
            "--config".to_string(),
            "./frame.json".to_string(),
            "--scenes".to_string(),
            "./scenes.json".to_string(),
            "--event-log".to_string(),
            "./events.log".to_string(),
        ])
        .expect("cli should parse");

        assert_eq!(cli.command, Command::Check);
        assert_eq!(cli.config_path, Some(PathBuf::from("./frame.json")));
        assert_eq!(cli.scene_manifest, Some(PathBuf::from("./scenes.json")));
        assert_eq!(cli.event_log_path, Some(PathBuf::from("./events.log")));
    }

    #[test]
    fn parses_parity_command_and_contract_flags() {
        let cli = Cli::parse(vec![
            "parity".to_string(),
            "--renderer-contract".to_string(),
            "./renderer.json".to_string(),
            "--driver-contract".to_string(),
            "./driver.json".to_string(),
        ])
        .expect("cli should parse");

        assert_eq!(cli.command, Command::Parity);
        assert_eq!(
            cli.renderer_contract_path,
            Some(PathBuf::from("./renderer.json"))
        );
        assert_eq!(
            cli.driver_contract_path,
            Some(PathBuf::from("./driver.json"))
        );
    }

    #[test]
    fn fails_on_unknown_command() {
        let error = Cli::parse(vec!["preview".to_string()]).expect_err("must fail");
        assert_eq!(error, CliParseError::UnknownCommand("preview".to_string()));
    }
}
