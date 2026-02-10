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
