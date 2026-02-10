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
fn contract_includes_event_stream_envelope_and_fields() {
    let contract = command_contract_json();

    assert_eq!(
        contract["event_stream"]["transport"],
        serde_json::json!("websocket")
    );
    assert_eq!(
        contract["event_stream"]["path"],
        serde_json::json!("/ws/events")
    );
    assert_eq!(
        contract["event_stream"]["message_envelope"]["timestamp"],
        serde_json::json!("number")
    );
    assert!(contract["events"]["runtime:ready"]["fields"]
        .as_array()
        .expect("ready fields should be array")
        .contains(&serde_json::json!("health_endpoint")));
}

#[test]
fn contract_exposes_command_event_field_map() {
    let contract = command_contract_json();

    let run_ready_fields = contract["command_event_fields"]["run"]["runtime:ready"]
        .as_array()
        .expect("run runtime:ready fields should be an array");
    assert!(run_ready_fields.contains(&serde_json::json!("health_endpoint")));
    assert!(run_ready_fields.contains(&serde_json::json!("event_stream_transport")));

    let check_ok_fields = contract["command_event_fields"]["check"]["runtime:check_ok"]
        .as_array()
        .expect("check runtime:check_ok fields should be an array");
    assert!(check_ok_fields.contains(&serde_json::json!("apps_loaded")));

    let parity_ok_fields = contract["command_event_fields"]["parity"]["runtime:parity_ok"]
        .as_array()
        .expect("parity runtime:parity_ok fields should be an array");
    assert!(parity_ok_fields.contains(&serde_json::json!("shared_formats")));
    assert!(parity_ok_fields.contains(&serde_json::json!("renderer_target_fps")));
    assert!(parity_ok_fields.contains(&serde_json::json!("renderer_tick_budget_ms")));
    assert!(parity_ok_fields.contains(&serde_json::json!("driver_backpressure_policy")));
}

#[test]
fn parses_event_log_flag() {
    let cli = Cli::parse(vec![
        "check".to_string(),
        "--event-log".to_string(),
        "./runtime.jsonl".to_string(),
    ])
    .expect("cli should parse");

    assert_eq!(cli.command, Command::Check);
    assert_eq!(
        cli.event_log_path,
        Some(std::path::PathBuf::from("./runtime.jsonl"))
    );
}

#[test]
fn parses_parity_contract_flags() {
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
        Some(std::path::PathBuf::from("./renderer.json"))
    );
    assert_eq!(
        cli.driver_contract_path,
        Some(std::path::PathBuf::from("./driver.json"))
    );
}
