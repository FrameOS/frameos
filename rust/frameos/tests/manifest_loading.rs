use frameos::manifests::{
    load_app_manifest, load_app_registry, load_scene_catalog, load_scene_graph_manifest,
    load_scene_manifest, ManifestLoadError,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_test_dir(name: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("frameos-{name}-{timestamp}"))
}

fn write_fixture(base: &Path, filename: &str, fixture: &str) -> PathBuf {
    fs::create_dir_all(base).expect("test directory should be creatable");
    let path = base.join(filename);
    fs::write(&path, fixture).expect("fixture should be writable");
    path
}

#[test]
fn loads_scene_manifest_from_disk() {
    let test_dir = unique_test_dir("scene-manifest-ok");
    let scene_path = write_fixture(
        &test_dir,
        "scenes.json",
        include_str!("fixtures/scenes-valid.json"),
    );

    let scenes = load_scene_manifest(&scene_path).expect("scene manifest should load");

    assert_eq!(scenes.len(), 2);
    fs::remove_dir_all(test_dir).expect("test directory should be removable");
}

#[test]
fn loads_app_registry_from_disk() {
    let test_dir = unique_test_dir("app-manifest-ok");
    let app_path = write_fixture(
        &test_dir,
        "apps.json",
        include_str!("fixtures/apps-valid.json"),
    );

    let registry = load_app_registry(&app_path).expect("app registry should load");

    assert_eq!(registry.apps().len(), 2);
    fs::remove_dir_all(test_dir).expect("test directory should be removable");
}

#[test]
fn reports_validation_error_for_invalid_scene_manifest() {
    let test_dir = unique_test_dir("scene-manifest-invalid");
    let scene_path = write_fixture(
        &test_dir,
        "scenes.json",
        include_str!("fixtures/scenes-invalid.json"),
    );

    let result = load_scene_catalog(&scene_path);

    assert!(matches!(
        result,
        Err(ManifestLoadError::Validation {
            manifest: "scene",
            index: 0,
            ..
        })
    ));
    fs::remove_dir_all(test_dir).expect("test directory should be removable");
}

#[test]
fn reports_parse_error_for_non_json_manifest() {
    let test_dir = unique_test_dir("manifest-bad-json");
    let app_path = write_fixture(&test_dir, "apps.json", "not-json");

    let result = load_app_manifest(&app_path);

    assert!(matches!(result, Err(ManifestLoadError::Parse { .. })));
    fs::remove_dir_all(test_dir).expect("test directory should be removable");
}

#[test]
fn loads_scene_graph_manifest_from_disk() {
    let test_dir = unique_test_dir("scene-graph-manifest-ok");
    let scene_path = write_fixture(
        &test_dir,
        "scenes-graph.json",
        include_str!("fixtures/scenes-graph-valid.json"),
    );

    let graphs = load_scene_graph_manifest(&scene_path).expect("scene graph manifest should load");

    assert_eq!(graphs.len(), 1);
    assert_eq!(graphs[0].id, "scene/linear");
    assert_eq!(graphs[0].entry_node, 1);
    fs::remove_dir_all(test_dir).expect("test directory should be removable");
}
