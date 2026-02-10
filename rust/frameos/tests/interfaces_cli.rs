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
