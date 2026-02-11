use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Run,
    Check,
    Parity,
    E2e,
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
    pub renderer_discovery_file: Option<PathBuf>,
    pub driver_discovery_file: Option<PathBuf>,
    pub renderer_discovery_json: Option<String>,
    pub driver_discovery_json: Option<String>,
    pub event_log_path: Option<PathBuf>,
    pub e2e_scenes_dir: Option<PathBuf>,
    pub e2e_snapshots_dir: Option<PathBuf>,
    pub e2e_assets_dir: Option<PathBuf>,
    pub e2e_output_dir: Option<PathBuf>,
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
            renderer_discovery_file: None,
            driver_discovery_file: None,
            renderer_discovery_json: None,
            driver_discovery_json: None,
            event_log_path: None,
            e2e_scenes_dir: None,
            e2e_snapshots_dir: None,
            e2e_assets_dir: None,
            e2e_output_dir: None,
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
                "e2e" => {
                    cli.command = Command::E2e;
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
                "--renderer-discovery-file" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--renderer-discovery-file"));
                    };
                    cli.renderer_discovery_file = Some(PathBuf::from(value));
                }
                "--driver-discovery-file" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--driver-discovery-file"));
                    };
                    cli.driver_discovery_file = Some(PathBuf::from(value));
                }
                "--renderer-discovery-json" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--renderer-discovery-json"));
                    };
                    cli.renderer_discovery_json = Some(value);
                }
                "--driver-discovery-json" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--driver-discovery-json"));
                    };
                    cli.driver_discovery_json = Some(value);
                }
                "--event-log" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--event-log"));
                    };
                    cli.event_log_path = Some(PathBuf::from(value));
                }
                "--e2e-scenes" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--e2e-scenes"));
                    };
                    cli.e2e_scenes_dir = Some(PathBuf::from(value));
                }
                "--e2e-snapshots" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--e2e-snapshots"));
                    };
                    cli.e2e_snapshots_dir = Some(PathBuf::from(value));
                }
                "--e2e-assets" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--e2e-assets"));
                    };
                    cli.e2e_assets_dir = Some(PathBuf::from(value));
                }
                "--e2e-output" => {
                    let Some(value) = iter.next() else {
                        return Err(CliParseError::MissingValue("--e2e-output"));
                    };
                    cli.e2e_output_dir = Some(PathBuf::from(value));
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
                "description": "Validate renderer/driver contracts against parity invariants (fixture files or discovery payloads).",
                "flags": ["--renderer-contract <path>", "--driver-contract <path>", "--renderer-discovery-file <path>", "--driver-discovery-file <path>", "--renderer-discovery-json <json>", "--driver-discovery-json <json>", "--event-log <path>"],
                "notes": "provide exactly one source per side: contract path or discovery payload"
            },
            "e2e": {
                "description": "Render e2e scenes and compare generated images against snapshot PNGs.",
                "flags": ["--e2e-scenes <dir>", "--e2e-snapshots <dir>", "--e2e-assets <dir>", "--e2e-output <dir>", "--event-log <path>"],
                "notes": "defaults resolve against repo root when paths are omitted"
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
            "runtime:parity_failed": {"level": "error", "fields": ["error", "duration_ms", "renderer_contract_source", "driver_contract_source", "renderer_source_label", "driver_source_label"]},
            "runtime:e2e_ok": {"level": "info", "fields": ["scenes_checked", "scenes_failed", "max_diff"]},
            "runtime:e2e_failed": {"level": "error", "fields": ["scenes_checked", "scenes_failed", "max_diff", "failing_scenes"]},
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
                "runtime:parity_failed": ["error", "duration_ms", "renderer_contract_source", "driver_contract_source", "renderer_source_label", "driver_source_label"]
            },
            "e2e": {
                "runtime:e2e_ok": ["scenes_checked", "scenes_failed", "max_diff"],
                "runtime:e2e_failed": ["scenes_checked", "scenes_failed", "max_diff", "failing_scenes"]
            },
            "contract": {}
        }
    })
}
