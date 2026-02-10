use frameos::config::{ConfigError, FrameOSConfig};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("frameos-rust-test-{name}-{nanos}.json"))
}

#[test]
fn loads_fixture_with_expected_values() {
    let path = temp_path("valid");
    fs::write(&path, include_str!("fixtures/frame-valid.json")).expect("fixture should write");

    let config = FrameOSConfig::load_from_path(&path).expect("config should parse");

    assert_eq!(config.name, "kitchen-frame");
    assert_eq!(config.server_host, "controller.local");
    assert_eq!(config.server_port, 9000);
    assert_eq!(config.frame_host, "kitchen.local");
    assert_eq!(config.frame_port, 8788);
    assert_eq!(config.metrics_interval_seconds, 15);
    assert!(config.debug);

    let _ = fs::remove_file(path);
}

#[test]
fn rejects_relative_assets_path() {
    let path = temp_path("relative-assets");
    fs::write(
        &path,
        r#"{
            "assets_path": "./assets",
            "width": 100,
            "height": 100
        }"#,
    )
    .expect("config fixture should write");

    let result = FrameOSConfig::load_from_path(&path);
    assert!(matches!(
        result,
        Err(ConfigError::ValidationFailed(message)) if message.contains("assets_path must be an absolute path")
    ));

    let _ = fs::remove_file(path);
}
