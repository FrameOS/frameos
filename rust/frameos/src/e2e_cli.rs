use std::fs;
use std::path::{Path, PathBuf};

use image::{DynamicImage, GenericImageView};

use crate::e2e::{E2eRenderer, E2eScene};

#[derive(Debug, Clone)]
pub struct E2eCliOptions {
    pub scenes_dir: PathBuf,
    pub snapshots_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub output_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct E2eSceneDiff {
    pub scene: String,
    pub diff: f64,
    pub threshold: f64,
}

#[derive(Debug, Clone)]
pub struct E2eReport {
    pub checked: usize,
    pub failed: Vec<E2eSceneDiff>,
    pub max_diff: f64,
}

impl E2eReport {
    pub fn passed(&self) -> bool {
        self.failed.is_empty()
    }
}

pub fn run_e2e_snapshot_parity(opts: &E2eCliOptions) -> Result<E2eReport, String> {
    fs::create_dir_all(&opts.output_dir).map_err(|error| {
        format!(
            "failed to create output dir {}: {error}",
            opts.output_dir.display()
        )
    })?;

    let renderer = E2eRenderer {
        width: 320,
        height: 480,
        assets_dir: opts.assets_dir.clone(),
    };

    let mut scene_paths = Vec::new();
    for entry in fs::read_dir(&opts.scenes_dir).map_err(|error| {
        format!(
            "failed to read scenes dir {}: {error}",
            opts.scenes_dir.display()
        )
    })? {
        let entry = entry.map_err(|error| format!("failed to read scene entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|v| v.to_str()) == Some("json") {
            scene_paths.push(path);
        }
    }
    scene_paths.sort();

    let checked = scene_paths.len();
    let mut failed = Vec::new();
    let mut max_diff = 0.0_f64;
    for scene_path in scene_paths {
        let scene_name = scene_path
            .file_stem()
            .and_then(|v| v.to_str())
            .ok_or_else(|| format!("invalid scene filename: {}", scene_path.display()))?
            .to_string();
        let scene = E2eScene::from_path(&scene_path)
            .map_err(|error| format!("failed to parse scene {scene_name}: {error}"))?;
        let rendered = renderer
            .render_scene(&scene)
            .map_err(|error| format!("failed to render scene {scene_name}: {error}"))?;

        let output_path = opts.output_dir.join(format!("{scene_name}.png"));
        rendered
            .save(&output_path)
            .map_err(|error| format!("failed to save rendered scene {scene_name}: {error}"))?;

        let snapshot_path = opts.snapshots_dir.join(format!("{scene_name}.png"));
        let snapshot = image::open(&snapshot_path).map_err(|error| {
            format!(
                "failed to open snapshot {} for scene {scene_name}: {error}",
                snapshot_path.display()
            )
        })?;

        let diff = mean_diff(&rendered, &snapshot);
        max_diff = max_diff.max(diff);
        let threshold = threshold_for_scene(&scene_name);
        if diff > threshold {
            failed.push(E2eSceneDiff {
                scene: scene_name,
                diff,
                threshold,
            });
        }
    }

    Ok(E2eReport {
        checked,
        failed,
        max_diff,
    })
}

pub fn default_e2e_options(repo_root: &Path) -> E2eCliOptions {
    E2eCliOptions {
        scenes_dir: repo_root.join("e2e/scenes"),
        snapshots_dir: repo_root.join("e2e/snapshots"),
        assets_dir: repo_root.join("e2e/assets"),
        output_dir: repo_root.join("e2e/rust-output"),
    }
}

fn threshold_for_scene(scene_name: &str) -> f64 {
    match scene_name {
        "dataDownloadImage" => 0.72,
        "dataResize" => 0.42,
        "renderSplitLoop" => 0.40,
        _ => 0.30,
    }
}

fn mean_diff(a: &DynamicImage, b: &DynamicImage) -> f64 {
    let (w, h) = a.dimensions();
    let resized = if b.dimensions() == (w, h) {
        b.clone()
    } else {
        b.resize_exact(w, h, image::imageops::FilterType::Lanczos3)
    };

    let mut total = 0.0;
    for y in 0..h {
        for x in 0..w {
            let pa = a.get_pixel(x, y).0;
            let pb = resized.get_pixel(x, y).0;
            for i in 0..4 {
                total += ((pa[i] as f64) - (pb[i] as f64)).abs() / 255.0;
            }
        }
    }
    total / ((w as f64) * (h as f64) * 4.0)
}
