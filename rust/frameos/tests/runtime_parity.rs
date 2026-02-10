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
