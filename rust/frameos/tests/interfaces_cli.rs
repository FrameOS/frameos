use frameos::interfaces::{command_contract_json, Cli, CliParseError, Command};

#[test]
fn defaults_to_run_command() {
    let cli = Cli::parse(Vec::<String>::new()).expect("cli should parse");
    assert_eq!(cli.command, Command::Run);
}

#[test]
fn rejects_flag_without_value() {
    let error = Cli::parse(vec!["--config".to_string()]).expect_err("must fail");
    assert_eq!(error, CliParseError::MissingValue("--config"));
}

#[test]
fn contract_lists_expected_commands() {
    let contract = command_contract_json();
    let commands = contract
        .get("commands")
        .and_then(serde_json::Value::as_object)
        .expect("commands should be object");

    assert!(commands.contains_key("run"));
    assert!(commands.contains_key("check"));
    assert!(commands.contains_key("parity"));
    assert!(commands.contains_key("contract"));
}

#[test]
fn parses_parity_discovery_flags() {
    let cli = Cli::parse(vec![
        "parity".to_string(),
        "--renderer-discovery-file".to_string(),
        "./renderer.discovery.json".to_string(),
        "--driver-discovery-json".to_string(),
        "{}".to_string(),
    ])
    .expect("cli should parse");

    assert_eq!(cli.command, Command::Parity);
    assert_eq!(
        cli.renderer_discovery_file,
        Some(std::path::PathBuf::from("./renderer.discovery.json"))
    );
    assert_eq!(cli.driver_discovery_json.as_deref(), Some("{}"));
}

#[test]
fn contract_includes_parity_diagnostic_fields() {
    let contract = command_contract_json();
    let parity_failed_fields = contract["events"]["runtime:parity_failed"]["fields"]
        .as_array()
        .expect("runtime:parity_failed fields should be array");
    assert!(parity_failed_fields.contains(&serde_json::json!("duration_ms")));
    assert!(parity_failed_fields.contains(&serde_json::json!("renderer_source_label")));
    assert!(parity_failed_fields.contains(&serde_json::json!("driver_source_label")));
}
