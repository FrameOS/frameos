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
fn renders_subset_of_e2e_scenes_close_to_snapshots() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let renderer = E2eRenderer {
        width: 320,
        height: 480,
        assets_dir: repo_root.join("e2e/assets"),
    };

    let scenes = [
        "black",
        "blue",
        "dataGradient",
        "renderColorFlow",
        "renderColorImage",
    ];

    for scene_name in scenes {
        let scene = E2eScene::from_path(&repo_root.join(format!("e2e/scenes/{scene_name}.json")))
            .expect("scene should parse");
        let rendered = renderer
            .render_scene(&scene)
            .expect("scene should render in subset harness");
        let snapshot = image::open(repo_root.join(format!("e2e/snapshots/{scene_name}.png")))
            .expect("snapshot should load");

        let diff = mean_diff(&rendered, &snapshot);
        assert!(diff <= 0.16, "scene {scene_name} diff too high: {diff:.4}");
    }
}
