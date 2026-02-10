use std::path::PathBuf;
use std::process::Command;

fn fixtures_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

#[test]
fn check_command_emits_golden_runtime_check_event_payload() {
    let binary = env!("CARGO_BIN_EXE_frameos");
    let output = Command::new(binary)
        .arg("check")
        .arg("--config")
        .arg(fixtures_path("frame-valid.json"))
        .arg("--scenes")
        .arg(fixtures_path("scenes-valid.json"))
        .arg("--apps")
        .arg(fixtures_path("apps-valid.json"))
        .output()
        .expect("check command should execute");

    assert!(
        output.status.success(),
        "check command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    let mut lines = stdout.lines();
    let event_line = lines.next().expect("event payload line should exist");
    let event_value: serde_json::Value =
        serde_json::from_str(event_line).expect("event line should be valid json");

    assert_eq!(
        event_value["event"]["event"],
        serde_json::Value::String("runtime:check_ok".to_string())
    );
    assert_eq!(event_value["event"]["apps_loaded"], serde_json::json!(2));
    assert_eq!(event_value["event"]["scenes_loaded"], serde_json::json!(2));
    assert!(stdout.contains("FrameOS check: passed"));
}

#[test]
fn contract_command_lists_heartbeat_and_metrics_tick_events() {
    let binary = env!("CARGO_BIN_EXE_frameos");
    let output = Command::new(binary)
        .arg("contract")
        .output()
        .expect("contract command should execute");

    assert!(output.status.success(), "contract command should succeed");

    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("runtime:heartbeat"));
    assert!(stdout.contains("runtime:metrics_tick"));
}

#[test]
fn check_command_supports_production_like_fixture_layout() {
    let binary = env!("CARGO_BIN_EXE_frameos");
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("production");

    let output = Command::new(binary)
        .arg("check")
        .arg("--config")
        .arg(fixture_dir.join("frame.json"))
        .arg("--scenes")
        .arg(fixture_dir.join("scenes.json"))
        .arg("--apps")
        .arg(fixture_dir.join("apps.json"))
        .output()
        .expect("check command should execute");

    assert!(
        output.status.success(),
        "check command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("runtime:check_ok"));
    assert!(stdout.contains("\"apps_loaded\":1"));
    assert!(stdout.contains("\"scenes_loaded\":1"));
}

#[test]
fn check_command_writes_json_lines_to_event_log_file() {
    let binary = env!("CARGO_BIN_EXE_frameos");
    let temp = tempfile::tempdir().expect("tempdir should be created");
    let event_log = temp.path().join("events.jsonl");

    let output = Command::new(binary)
        .arg("check")
        .arg("--config")
        .arg(fixtures_path("frame-valid.json"))
        .arg("--event-log")
        .arg(&event_log)
        .output()
        .expect("check command should execute");

    assert!(
        output.status.success(),
        "check command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let file_contents = std::fs::read_to_string(&event_log).expect("event log should be readable");
    let first_line = file_contents
        .lines()
        .next()
        .expect("event log should contain at least one line");
    let payload: serde_json::Value =
        serde_json::from_str(first_line).expect("line should be valid json");
    assert_eq!(
        payload["event"]["event"],
        serde_json::json!("runtime:check_ok")
    );
}

#[test]
fn check_command_uses_config_log_to_file_when_flag_not_set() {
    let binary = env!("CARGO_BIN_EXE_frameos");
    let temp = tempfile::tempdir().expect("tempdir should be created");
    let event_log = temp.path().join("config-events.jsonl");
    let config_path = temp.path().join("frame.json");
    let config_template = std::fs::read_to_string(fixtures_path("frame-log-to-file.json"))
        .expect("fixture config should be readable");
    let config_contents = config_template.replace(
        "/tmp/replace-at-runtime/events.jsonl",
        &event_log.to_string_lossy(),
    );
    std::fs::write(&config_path, config_contents).expect("temp config should be writable");

    let output = Command::new(binary)
        .arg("check")
        .arg("--config")
        .arg(&config_path)
        .output()
        .expect("check command should execute");

    assert!(
        output.status.success(),
        "check command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let file_contents = std::fs::read_to_string(&event_log).expect("event log should be readable");
    assert!(file_contents.contains("runtime:check_ok"));
}

#[test]
fn check_command_flag_event_log_overrides_config_log_to_file() {
    let binary = env!("CARGO_BIN_EXE_frameos");
    let temp = tempfile::tempdir().expect("tempdir should be created");
    let config_log = temp.path().join("config-events.jsonl");
    let cli_log = temp.path().join("cli-events.jsonl");
    let config_path = temp.path().join("frame.json");
    let config_template = std::fs::read_to_string(fixtures_path("frame-log-to-file.json"))
        .expect("fixture config should be readable");
    let config_contents = config_template.replace(
        "/tmp/replace-at-runtime/events.jsonl",
        &config_log.to_string_lossy(),
    );
    std::fs::write(&config_path, config_contents).expect("temp config should be writable");

    let output = Command::new(binary)
        .arg("check")
        .arg("--config")
        .arg(&config_path)
        .arg("--event-log")
        .arg(&cli_log)
        .output()
        .expect("check command should execute");

    assert!(
        output.status.success(),
        "check command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let cli_contents = std::fs::read_to_string(&cli_log).expect("cli event log should be readable");
    assert!(cli_contents.contains("runtime:check_ok"));

    let config_contents = std::fs::read_to_string(&config_log).unwrap_or_default();
    assert!(
        config_contents.is_empty(),
        "config log should remain empty when CLI flag overrides"
    );
}

#[test]
fn parity_command_emits_runtime_parity_ok_event() {
    let binary = env!("CARGO_BIN_EXE_frameos");

    let output = Command::new(binary)
        .arg("parity")
        .arg("--renderer-contract")
        .arg(fixtures_path("parity/renderer-valid.json"))
        .arg("--driver-contract")
        .arg(fixtures_path("parity/driver-valid.json"))
        .output()
        .expect("parity command should execute");

    assert!(
        output.status.success(),
        "parity command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("runtime:parity_ok"));
    assert!(stdout.contains("FrameOS parity check: passed"));
}

#[test]
fn parity_command_fails_for_invalid_contract_pair() {
    let binary = env!("CARGO_BIN_EXE_frameos");

    let output = Command::new(binary)
        .arg("parity")
        .arg("--renderer-contract")
        .arg(fixtures_path("parity/renderer-valid.json"))
        .arg("--driver-contract")
        .arg(fixtures_path("parity/driver-invalid.json"))
        .output()
        .expect("parity command should execute");

    assert!(!output.status.success(), "parity command should fail");

    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("runtime:parity_failed"));
}

#[test]
fn parity_command_fails_for_renderer_scheduling_failure_mode() {
    let binary = env!("CARGO_BIN_EXE_frameos");

    let output = Command::new(binary)
        .arg("parity")
        .arg("--renderer-contract")
        .arg(fixtures_path("parity/renderer-invalid-scheduling.json"))
        .arg("--driver-contract")
        .arg(fixtures_path("parity/driver-valid.json"))
        .output()
        .expect("parity command should execute");

    assert!(!output.status.success(), "parity command should fail");

    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("runtime:parity_failed"));
    assert!(stdout.contains("target_fps (60) must be <= max_fps (30)"));
}

#[test]
fn parity_command_supports_probe_commands_as_sources() {
    let binary = env!("CARGO_BIN_EXE_frameos");
    let renderer_fixture = fixtures_path("parity/renderer-valid.json");
    let driver_fixture = fixtures_path("parity/driver-valid.json");

    let output = Command::new(binary)
        .arg("parity")
        .arg("--renderer-probe-cmd")
        .arg(format!("cat {}", renderer_fixture.to_string_lossy()))
        .arg("--driver-probe-cmd")
        .arg(format!("cat {}", driver_fixture.to_string_lossy()))
        .output()
        .expect("parity command should execute");

    assert!(
        output.status.success(),
        "parity command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("runtime:parity_ok"));
    assert!(stdout.contains("\"renderer_contract_source\":\"discovered\""));
    assert!(stdout.contains("\"driver_contract_source\":\"discovered\""));
}

#[test]
fn parity_command_rejects_mixed_source_flags_for_renderer_side() {
    let binary = env!("CARGO_BIN_EXE_frameos");

    let output = Command::new(binary)
        .arg("parity")
        .arg("--renderer-contract")
        .arg(fixtures_path("parity/renderer-valid.json"))
        .arg("--renderer-probe-cmd")
        .arg("echo '{}' ")
        .arg("--driver-contract")
        .arg(fixtures_path("parity/driver-valid.json"))
        .output()
        .expect("parity command should execute");

    assert!(!output.status.success(), "parity command should fail");
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("--renderer-contract <path> and --renderer-probe-cmd <shell command> are mutually exclusive")
    );
}
