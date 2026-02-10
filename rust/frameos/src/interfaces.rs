use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Run,
    Check,
    PrintContract,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub command: Command,
    pub config_path: Option<PathBuf>,
    pub scene_manifest: Option<PathBuf>,
    pub app_manifest: Option<PathBuf>,
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
                "flags": ["--config <path>", "--scenes <path>", "--apps <path>"]
            },
            "check": {
                "description": "Validate that config and optional manifests can be loaded.",
                "flags": ["--config <path>", "--scenes <path>", "--apps <path>"]
            },
            "contract": {
                "description": "Print the runtime CLI/event contract as JSON.",
                "flags": []
            }
        },
        "events": {
            "runtime:start": {"level": "info"},
            "runtime:ready": {"level": "info"},
            "runtime:stop": {"level": "info"},
            "runtime:check_ok": {"level": "info"},
            "runtime:check_failed": {"level": "error"},
            "runtime:heartbeat": {"level": "debug"},
            "runtime:metrics_tick": {"level": "info"}
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
        ])
        .expect("cli should parse");

        assert_eq!(cli.command, Command::Check);
        assert_eq!(cli.config_path, Some(PathBuf::from("./frame.json")));
        assert_eq!(cli.scene_manifest, Some(PathBuf::from("./scenes.json")));
    }

    #[test]
    fn fails_on_unknown_command() {
        let error = Cli::parse(vec!["preview".to_string()]).expect_err("must fail");
        assert_eq!(error, CliParseError::UnknownCommand("preview".to_string()));
    }
}
