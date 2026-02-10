use frameos::models::{AppDescriptor, SceneDescriptor};

#[test]
fn loads_valid_scene_manifest_fixture() {
    let scenes: Vec<SceneDescriptor> =
        serde_json::from_str(include_str!("fixtures/scenes-valid.json"))
            .expect("scene fixture should deserialize");

    assert_eq!(scenes.len(), 2);
    for scene in scenes {
        scene
            .validate()
            .expect("scene fixture entries should validate");
    }
}

#[test]
fn loads_valid_app_manifest_fixture() {
    let apps: Vec<AppDescriptor> = serde_json::from_str(include_str!("fixtures/apps-valid.json"))
        .expect("app fixture should deserialize");

    assert_eq!(apps.len(), 2);
    for app in apps {
        app.validate().expect("app fixture entries should validate");
    }
}

#[test]
fn rejects_invalid_scene_manifest_fixture() {
    let scenes: Vec<SceneDescriptor> =
        serde_json::from_str(include_str!("fixtures/scenes-invalid.json"))
            .expect("scene fixture should deserialize");

    assert!(scenes.iter().any(|scene| scene.validate().is_err()));
}
