use std::path::Path;

use frameos::e2e::{E2eRenderer, E2eScene};
use image::{DynamicImage, GenericImageView};

fn mean_diff(a: &DynamicImage, b: &DynamicImage) -> f64 {
    let (w, h) = a.dimensions();
    let b = if b.dimensions() == (w, h) {
        b.clone()
    } else {
        b.resize_exact(w, h, image::imageops::FilterType::Lanczos3)
    };

    let mut total = 0.0;
    for y in 0..h {
        for x in 0..w {
            let pa = a.get_pixel(x, y).0;
            let pb = b.get_pixel(x, y).0;
            for i in 0..4 {
                total += ((pa[i] as f64) - (pb[i] as f64)).abs() / 255.0;
            }
        }
    }
    total / ((w as f64) * (h as f64) * 4.0)
}

#[test]
fn renders_all_e2e_scenes_close_to_snapshots() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let renderer = E2eRenderer {
        width: 320,
        height: 480,
        assets_dir: repo_root.join("e2e/assets"),
    };

    let mut failures = Vec::new();
    for scene_path in std::fs::read_dir(repo_root.join("e2e/scenes")).expect("list scenes") {
        let scene_path = scene_path.expect("entry").path();
        if scene_path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let scene_name = scene_path.file_stem().and_then(|s| s.to_str()).unwrap();
        let scene = E2eScene::from_path(&scene_path).expect("scene should parse");
        let rendered = renderer
            .render_scene(&scene)
            .unwrap_or_else(|e| panic!("scene {scene_name} should render: {e}"));
        let snapshot = image::open(repo_root.join(format!("e2e/snapshots/{scene_name}.png")))
            .expect("snapshot should load");
        let diff = mean_diff(&rendered, &snapshot);
        let threshold = match scene_name {
            "dataDownloadImage" => 0.72,
            "dataResize" => 0.42,
            "renderSplitLoop" => 0.40,
            _ => 0.30,
        };
        if diff > threshold {
            failures.push(format!("{scene_name}:{diff:.4} > {threshold:.2}"));
        }
    }

    assert!(
        failures.is_empty(),
        "scenes exceeded diff threshold: {}",
        failures.join(", ")
    );
}
