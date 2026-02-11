use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, Rgba, RgbaImage};
use serde_json::{Map, Value};

#[derive(Debug, Clone)]
struct SceneNode {
    id: String,
    keyword: String,
    config: Map<String, Value>,
    node_type: String,
}

#[derive(Debug, Clone)]
struct SceneEdge {
    source: String,
    source_handle: String,
    target: String,
    target_handle: String,
}

#[derive(Debug, Clone)]
pub struct E2eScene {
    nodes: Vec<SceneNode>,
    edges: Vec<SceneEdge>,
    name: String,
    background_color: String,
}

#[derive(Debug)]
pub enum E2eError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Invalid(String),
    Unsupported(String),
    Image(image::ImageError),
}

impl std::fmt::Display for E2eError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "io error: {err}"),
            Self::Json(err) => write!(f, "json error: {err}"),
            Self::Invalid(msg) => write!(f, "invalid scene: {msg}"),
            Self::Unsupported(msg) => write!(f, "unsupported scene: {msg}"),
            Self::Image(err) => write!(f, "image error: {err}"),
        }
    }
}

impl std::error::Error for E2eError {}
impl From<std::io::Error> for E2eError {
    fn from(v: std::io::Error) -> Self {
        Self::Io(v)
    }
}
impl From<serde_json::Error> for E2eError {
    fn from(v: serde_json::Error) -> Self {
        Self::Json(v)
    }
}
impl From<image::ImageError> for E2eError {
    fn from(v: image::ImageError) -> Self {
        Self::Image(v)
    }
}

#[derive(Clone)]
pub struct E2eRenderer {
    pub width: u32,
    pub height: u32,
    pub assets_dir: PathBuf,
}

#[derive(Clone)]
enum NodeOutput {
    Image(DynamicImage),
}

impl E2eScene {
    pub fn from_path(path: &Path) -> Result<Self, E2eError> {
        let value: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
        let nodes = value
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| E2eError::Invalid("missing nodes".to_string()))?;
        let edges = value
            .get("edges")
            .and_then(Value::as_array)
            .ok_or_else(|| E2eError::Invalid("missing edges".to_string()))?;

        let mut parsed_nodes = Vec::new();
        for node in nodes {
            let id = node
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| E2eError::Invalid("node missing id".to_string()))?;
            let node_type = node
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("app")
                .to_string();
            let data = node
                .get("data")
                .and_then(Value::as_object)
                .ok_or_else(|| E2eError::Invalid(format!("node {id} missing data")))?;
            let keyword = data
                .get("keyword")
                .and_then(Value::as_str)
                .ok_or_else(|| E2eError::Invalid(format!("node {id} missing keyword")))?
                .to_string();
            let config = data
                .get("config")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            parsed_nodes.push(SceneNode {
                id: id.to_string(),
                keyword,
                config,
                node_type,
            });
        }

        let mut parsed_edges = Vec::new();
        for edge in edges {
            parsed_edges.push(SceneEdge {
                source: edge
                    .get("source")
                    .and_then(Value::as_str)
                    .ok_or_else(|| E2eError::Invalid("edge missing source".to_string()))?
                    .to_string(),
                source_handle: edge
                    .get("sourceHandle")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                target: edge
                    .get("target")
                    .and_then(Value::as_str)
                    .ok_or_else(|| E2eError::Invalid("edge missing target".to_string()))?
                    .to_string(),
                target_handle: edge
                    .get("targetHandle")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            });
        }

        Ok(Self {
            nodes: parsed_nodes,
            edges: parsed_edges,
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("scene")
                .to_string(),
            background_color: value
                .get("settings")
                .and_then(Value::as_object)
                .and_then(|settings| settings.get("backgroundColor"))
                .and_then(Value::as_str)
                .unwrap_or("#000000")
                .to_string(),
        })
    }
}

impl E2eRenderer {
    pub fn render_scene(&self, scene: &E2eScene) -> Result<DynamicImage, E2eError> {
        let mut by_id = HashMap::new();
        for node in &scene.nodes {
            by_id.insert(node.id.clone(), node.clone());
        }

        let entry = scene
            .nodes
            .iter()
            .find(|node| node.node_type == "event" && node.keyword == "render")
            .ok_or_else(|| {
                E2eError::Invalid(format!("scene {} has no render event", scene.name))
            })?;

        let mut cache = HashMap::new();
        let next = scene
            .edges
            .iter()
            .find(|edge| edge.source == entry.id && edge.source_handle == "next");

        if let Some(next) = next {
            let NodeOutput::Image(img) = self.exec_node(&next.target, scene, &by_id, &mut cache)?;
            Ok(img)
        } else {
            Ok(self.canvas_with_bg(&scene.background_color))
        }
    }

    fn exec_node(
        &self,
        node_id: &str,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<NodeOutput, E2eError> {
        if let Some(v) = cache.get(node_id) {
            return Ok(v.clone());
        }
        let node = nodes
            .get(node_id)
            .ok_or_else(|| E2eError::Invalid(format!("missing node {node_id}")))?;

        let result = match node.keyword.as_str() {
            "render/color" => NodeOutput::Image(self.render_color(node)),
            "render/gradient" => NodeOutput::Image(self.render_gradient(node)),
            "data/newImage" => NodeOutput::Image(self.render_new_image(node)),
            "data/localImage" => NodeOutput::Image(self.render_local_image(node)?),
            "render/image" => {
                let mut target = self.default_canvas();
                if let Some(next_edge) = scene
                    .edges
                    .iter()
                    .find(|e| e.source == node.id && e.source_handle == "next")
                {
                    let NodeOutput::Image(img) =
                        self.exec_node(&next_edge.target, scene, nodes, cache)?;
                    target = img;
                }
                let input_image_edge = scene
                    .edges
                    .iter()
                    .find(|edge| edge.target == node.id && edge.target_handle == "fieldInput/image")
                    .ok_or_else(|| {
                        E2eError::Invalid(format!(
                            "render/image {} missing image input edge",
                            node.id
                        ))
                    })?;
                let NodeOutput::Image(source) =
                    self.exec_node(&input_image_edge.source, scene, nodes, cache)?;
                NodeOutput::Image(self.composite_image(target, source, node))
            }
            "render/split" => {
                // Keep scope constrained for this iteration: flows that rely on split are deferred.
                return Err(E2eError::Unsupported(
                    "render/split is not implemented in e2e renderer yet".to_string(),
                ));
            }
            other => {
                return Err(E2eError::Unsupported(format!(
                    "keyword {other} is not implemented"
                )))
            }
        };

        cache.insert(node_id.to_string(), result.clone());
        Ok(result)
    }

    fn default_canvas(&self) -> DynamicImage {
        self.canvas_with_bg("#000000")
    }

    fn canvas_with_bg(&self, color: &str) -> DynamicImage {
        let rgba = parse_hex_color(color).unwrap_or([0, 0, 0, 255]);
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(self.width, self.height, Rgba(rgba)))
    }

    fn render_color(&self, node: &SceneNode) -> DynamicImage {
        let color = node
            .config
            .get("color")
            .and_then(Value::as_str)
            .unwrap_or("#000000");
        let rgba = parse_hex_color(color).unwrap_or([0, 0, 0, 255]);
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(self.width, self.height, Rgba(rgba)))
    }

    fn render_gradient(&self, node: &SceneNode) -> DynamicImage {
        let start = parse_hex_color(
            node.config
                .get("startColor")
                .and_then(Value::as_str)
                .unwrap_or("#000000"),
        )
        .unwrap_or([0, 0, 0, 255]);
        let end = parse_hex_color(
            node.config
                .get("endColor")
                .and_then(Value::as_str)
                .unwrap_or("#FFFFFF"),
        )
        .unwrap_or([255, 255, 255, 255]);
        let angle = node
            .config
            .get("angle")
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse::<f32>().ok())
                    .or_else(|| v.as_f64().map(|n| n as f32))
            })
            .unwrap_or(45.0);

        let mut out = RgbaImage::new(self.width, self.height);
        let theta = angle.to_radians();
        let dx = theta.cos();
        let dy = theta.sin();
        let cx = (self.width as f32) / 2.0;
        let cy = (self.height as f32) / 2.0;
        let half_diag =
            (((self.width * self.width + self.height * self.height) as f32).sqrt()) / 2.0;

        for y in 0..self.height {
            for x in 0..self.width {
                let px = x as f32 - cx;
                let py = y as f32 - cy;
                let proj = (px * dx + py * dy) / half_diag;
                let t = ((proj + 1.0) / 2.0).clamp(0.0, 1.0);
                let blend =
                    |a: u8, b: u8| -> u8 { ((a as f32) + (b as f32 - a as f32) * t).round() as u8 };
                out.put_pixel(
                    x,
                    y,
                    Rgba([
                        blend(start[0], end[0]),
                        blend(start[1], end[1]),
                        blend(start[2], end[2]),
                        255,
                    ]),
                );
            }
        }

        DynamicImage::ImageRgba8(out)
    }

    fn render_new_image(&self, node: &SceneNode) -> DynamicImage {
        let width = node
            .config
            .get("width")
            .and_then(|v| as_u32(v))
            .unwrap_or(self.width);
        let height = node
            .config
            .get("height")
            .and_then(|v| as_u32(v))
            .unwrap_or(self.height);
        let mut rgba = parse_hex_color(
            node.config
                .get("color")
                .and_then(Value::as_str)
                .unwrap_or("#000000"),
        )
        .unwrap_or([0, 0, 0, 255]);
        let opacity = node
            .config
            .get("opacity")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .clamp(0.0, 1.0);
        rgba[3] = (255.0 * opacity) as u8;
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(width, height, Rgba(rgba)))
    }

    fn render_local_image(&self, node: &SceneNode) -> Result<DynamicImage, E2eError> {
        let path = node
            .config
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| E2eError::Invalid("data/localImage requires path".to_string()))?;
        let full = self.assets_dir.join(path);
        Ok(image::open(full)?)
    }

    fn composite_image(
        &self,
        mut target: DynamicImage,
        source: DynamicImage,
        node: &SceneNode,
    ) -> DynamicImage {
        let placement = node
            .config
            .get("placement")
            .and_then(Value::as_str)
            .unwrap_or("center");

        let (tw, th) = target.dimensions();
        let (sw, sh) = source.dimensions();

        let resized = match placement {
            "cover" => {
                let scale = (tw as f32 / sw as f32).max(th as f32 / sh as f32);
                source.resize(
                    (sw as f32 * scale) as u32,
                    (sh as f32 * scale) as u32,
                    FilterType::Lanczos3,
                )
            }
            "contain" => {
                let scale = (tw as f32 / sw as f32).min(th as f32 / sh as f32);
                source.resize(
                    (sw as f32 * scale) as u32,
                    (sh as f32 * scale) as u32,
                    FilterType::Lanczos3,
                )
            }
            "stretch" => source.resize_exact(tw, th, FilterType::Lanczos3),
            _ => source,
        };

        let (rw, rh) = resized.dimensions();
        let x = ((tw as i64 - rw as i64) / 2).max(0) as u32;
        let y = ((th as i64 - rh as i64) / 2).max(0) as u32;
        image::imageops::overlay(&mut target, &resized, x as i64, y as i64);
        target
    }
}

fn parse_hex_color(input: &str) -> Option<[u8; 4]> {
    let hex = input.trim().trim_start_matches('#');
    match hex.len() {
        6 => Some([
            u8::from_str_radix(&hex[0..2], 16).ok()?,
            u8::from_str_radix(&hex[2..4], 16).ok()?,
            u8::from_str_radix(&hex[4..6], 16).ok()?,
            255,
        ]),
        8 => Some([
            u8::from_str_radix(&hex[0..2], 16).ok()?,
            u8::from_str_radix(&hex[2..4], 16).ok()?,
            u8::from_str_radix(&hex[4..6], 16).ok()?,
            u8::from_str_radix(&hex[6..8], 16).ok()?,
        ]),
        _ => None,
    }
}

fn as_u32(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}
