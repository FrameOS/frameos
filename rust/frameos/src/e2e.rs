use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use ab_glyph::{FontArc, PxScale};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, Rgba, RgbaImage};
use imageproc::drawing::draw_text_mut;
use qrcode::QrCode;
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
    Text(String),
    Bool(bool),
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
            let Some(keyword) = data
                .get("keyword")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
            else {
                continue;
            };
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
        if let Some(next) = scene
            .edges
            .iter()
            .find(|edge| edge.source == entry.id && edge.source_handle == "next")
        {
            let NodeOutput::Image(img) = self.exec_node(&next.target, scene, &by_id, &mut cache)?
            else {
                return Err(E2eError::Invalid(
                    "render pipeline root did not return image".to_string(),
                ));
            };
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
        let Some(node) = nodes.get(node_id) else {
            return Ok(NodeOutput::Image(self.default_canvas()));
        };

        let result = match node.keyword.as_str() {
            "render/color" => NodeOutput::Image(self.render_color(node)),
            "render/gradient" => NodeOutput::Image(self.render_gradient(node)),
            "data/newImage" => NodeOutput::Image(self.render_new_image(node)),
            "data/localImage" => NodeOutput::Image(self.render_local_image(node)?),
            "data/resizeImage" => {
                NodeOutput::Image(self.render_resize_image(node, scene, nodes, cache)?)
            }
            "render/image" => NodeOutput::Image(self.render_image(node, scene, nodes, cache)?),
            "render/split" | "renderGradientSplit" | "renderTextSplit" => {
                NodeOutput::Image(self.render_split(node, scene, nodes, cache)?)
            }
            "render/text" | "renderTextRich" => {
                NodeOutput::Image(self.render_text(node, scene, nodes, cache)?)
            }
            "render/opacity" => NodeOutput::Image(self.render_opacity(node, scene, nodes, cache)?),
            "data/qr" => NodeOutput::Image(self.render_qr(node)),
            "data/downloadImage" => NodeOutput::Image(self.download_image(node)?),
            "data/downloadUrl" => NodeOutput::Text(self.download_text(node)),
            "logic/ifElse" | "logicIfElse" => self.logic_if_else(node, scene, nodes, cache)?,
            "logic/setAsState" => self.logic_set_as_state(node, scene, nodes, cache)?,
            other => {
                return Err(E2eError::Unsupported(format!(
                    "keyword {other} is not implemented"
                )))
            }
        };

        cache.insert(node_id.to_string(), result.clone());
        Ok(result)
    }

    fn render_split(
        &self,
        node: &SceneNode,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<DynamicImage, E2eError> {
        let rows = config_i32(&node.config, "rows", 1).max(1) as usize;
        let cols = config_i32(&node.config, "columns", 1).max(1) as usize;
        let hide_empty = config_bool(&node.config, "hideEmpty", false);
        let (margin_t, margin_r, margin_b, margin_l) =
            parse_quad(&config_string(&node.config, "margin", ""), 0.0);
        let (gap_h, gap_v) = parse_pair(&config_string(&node.config, "gap", ""), 0.0);
        let width_ratios = parse_ratio_list(&config_string(&node.config, "width_ratios", ""), cols);
        let height_ratios =
            parse_ratio_list(&config_string(&node.config, "height_ratios", ""), rows);

        let mut output = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            self.width,
            self.height,
            Rgba([0, 0, 0, 0]),
        ));

        let inner_w =
            (self.width as f32 - margin_l - margin_r - gap_h * (cols.saturating_sub(1) as f32))
                .max(1.0);
        let inner_h =
            (self.height as f32 - margin_t - margin_b - gap_v * (rows.saturating_sub(1) as f32))
                .max(1.0);
        let mut col_widths = distribute(inner_w, &width_ratios);
        let mut row_heights = distribute(inner_h, &height_ratios);
        fix_last_dimension(
            &mut col_widths,
            self.width as i32
                - margin_l as i32
                - margin_r as i32
                - gap_h as i32 * (cols.saturating_sub(1) as i32),
        );
        fix_last_dimension(
            &mut row_heights,
            self.height as i32
                - margin_t as i32
                - margin_b as i32
                - gap_v as i32 * (rows.saturating_sub(1) as i32),
        );

        let fallback = scene
            .edges
            .iter()
            .find(|e| e.source == node.id && e.source_handle == "field/render_function")
            .map(|e| e.target.clone());
        let mut y = margin_t;
        for r in 0..rows {
            let mut x = margin_l;
            for c in 0..cols {
                let handle = format!("field/render_functions[{}][{}]", r + 1, c + 1);
                let renderer = scene
                    .edges
                    .iter()
                    .find(|e| e.source == node.id && e.source_handle == handle)
                    .map(|e| e.target.clone())
                    .or_else(|| fallback.clone());
                if let Some(renderer) = renderer {
                    let sub = E2eRenderer {
                        width: col_widths[c],
                        height: row_heights[r],
                        assets_dir: self.assets_dir.clone(),
                    };
                    if let NodeOutput::Image(cell_img) =
                        sub.exec_node(&renderer, scene, nodes, cache)?
                    {
                        image::imageops::overlay(&mut output, &cell_img, x as i64, y as i64);
                    }
                } else if !hide_empty {
                    let fill = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
                        col_widths[c],
                        row_heights[r],
                        Rgba([0, 0, 0, 255]),
                    ));
                    image::imageops::overlay(&mut output, &fill, x as i64, y as i64);
                }
                x += col_widths[c] as f32 + gap_h;
            }
            y += row_heights[r] as f32 + gap_v;
        }
        Ok(output)
    }

    fn render_text(
        &self,
        node: &SceneNode,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<DynamicImage, E2eError> {
        let mut img = self
            .find_input_image(&node.id, "fieldInput/inputImage", scene, nodes, cache)?
            .unwrap_or_else(|| self.default_canvas());
        let mut text = config_string(&node.config, "text", "");
        if let Some(val) =
            self.find_edge_input_value(&node.id, "fieldInput/text", scene, nodes, cache)?
        {
            text = val;
        }
        if text.is_empty() {
            return Ok(img);
        }
        let color = parse_hex_color(&config_string(&node.config, "fontColor", "#ffffff"))
            .unwrap_or([255, 255, 255, 255]);
        let border = parse_hex_color(&config_string(&node.config, "borderColor", "#000000"))
            .unwrap_or([0, 0, 0, 255]);
        let border_w = config_i32(&node.config, "borderWidth", 0).max(0);
        let font_size = config_f32(&node.config, "fontSize", 32.0);
        let position = config_string(&node.config, "position", "center");
        let valign = config_string(&node.config, "vAlign", "center");
        let font = load_font();
        let Some(font) = font else {
            return Ok(img);
        };

        let lines: Vec<&str> = text.split('\n').collect();
        let line_h = (font_size * 1.2).max(1.0) as i32;
        let text_h = line_h * i32::try_from(lines.len()).unwrap_or(1);
        let y0 = match valign.as_str() {
            "top" => 5,
            "bottom" => img.height() as i32 - text_h - 5,
            _ => (img.height() as i32 - text_h) / 2,
        };

        for (i, line) in lines.iter().enumerate() {
            let w = (line.chars().count() as f32 * font_size * 0.56) as i32;
            let x = match position.as_str() {
                "left" => 5,
                "right" => img.width() as i32 - w - 5,
                _ => (img.width() as i32 - w) / 2,
            };
            let y = y0 + (i as i32) * line_h;
            let rgba = Rgba(color);
            let brgba = Rgba(border);
            let canvas = img.as_mut_rgba8().expect("rgba8");
            for dx in -border_w..=border_w {
                for dy in -border_w..=border_w {
                    if dx != 0 || dy != 0 {
                        draw_text_mut(
                            canvas,
                            brgba,
                            x + dx,
                            y + dy,
                            PxScale::from(font_size),
                            &font,
                            line,
                        );
                    }
                }
            }
            draw_text_mut(canvas, rgba, x, y, PxScale::from(font_size), &font, line);
        }
        Ok(img)
    }

    fn render_opacity(
        &self,
        node: &SceneNode,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<DynamicImage, E2eError> {
        let mut img = self
            .find_input_image(&node.id, "fieldInput/image", scene, nodes, cache)?
            .unwrap_or_else(|| self.default_canvas());
        let opacity = config_f32(&node.config, "opacity", 1.0).clamp(0.0, 1.0);
        if let Some(buf) = img.as_mut_rgba8() {
            for p in buf.pixels_mut() {
                p[3] = ((p[3] as f32) * opacity).round() as u8;
            }
        }
        Ok(img)
    }

    fn render_resize_image(
        &self,
        node: &SceneNode,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<DynamicImage, E2eError> {
        let source = self
            .find_input_image(&node.id, "fieldInput/image", scene, nodes, cache)?
            .unwrap_or_else(|| self.default_canvas());
        let width = config_u32(&node.config, "width", source.width());
        let height = config_u32(&node.config, "height", source.height());
        let mode = config_string(&node.config, "scalingMode", "contain");
        Ok(scale_to_mode(source, width, height, &mode))
    }

    fn render_qr(&self, node: &SceneNode) -> DynamicImage {
        let code_text = config_string(&node.config, "code", "frameos");
        let size = config_u32(&node.config, "size", 180).max(32);
        let dark = parse_hex_color(&config_string(&node.config, "qrCodeColor", "#000000"))
            .unwrap_or([0, 0, 0, 255]);
        let light = parse_hex_color(&config_string(&node.config, "backgroundColor", "#ffffff"))
            .unwrap_or([255, 255, 255, 255]);
        match QrCode::new(code_text.as_bytes()) {
            Ok(code) => {
                let image = code
                    .render::<image::Luma<u8>>()
                    .max_dimensions(size, size)
                    .build();
                let mut out = RgbaImage::from_pixel(image.width(), image.height(), Rgba(light));
                for (x, y, p) in image.enumerate_pixels() {
                    if p[0] < 128 {
                        out.put_pixel(x, y, Rgba(dark));
                    }
                }
                DynamicImage::ImageRgba8(out)
            }
            Err(_) => self.default_canvas(),
        }
    }

    fn download_image(&self, node: &SceneNode) -> Result<DynamicImage, E2eError> {
        let url = config_string(&node.config, "url", "");
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Ok(self.error_image("invalid url"));
        }
        match reqwest::blocking::get(url).and_then(|r| r.bytes()) {
            Ok(bytes) => match image::load_from_memory(&bytes) {
                Ok(img) => Ok(img),
                Err(_) => Ok(self.error_image("decode")),
            },
            Err(_) => Ok(self.error_image("download")),
        }
    }

    fn download_text(&self, node: &SceneNode) -> String {
        let url = config_string(&node.config, "url", "");
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return "invalid url".to_string();
        }
        reqwest::blocking::get(url)
            .and_then(|r| r.text())
            .unwrap_or_else(|e| e.to_string())
    }

    fn logic_if_else(
        &self,
        node: &SceneNode,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<NodeOutput, E2eError> {
        let condition = if let Some(input) = scene
            .edges
            .iter()
            .find(|e| e.target == node.id && e.target_handle == "fieldInput/condition")
        {
            match self.exec_node(&input.source, scene, nodes, cache)? {
                NodeOutput::Bool(v) => v,
                NodeOutput::Text(t) => !t.trim().is_empty() && t.trim() != "false",
                NodeOutput::Image(_) => true,
            }
        } else {
            config_bool(&node.config, "condition", false)
        };
        let target = if condition {
            "field/thenNode"
        } else {
            "field/elseNode"
        };
        if let Some(edge) = scene
            .edges
            .iter()
            .find(|e| e.source == node.id && e.source_handle == target)
        {
            self.exec_node(&edge.target, scene, nodes, cache)
        } else {
            Ok(NodeOutput::Bool(condition))
        }
    }

    fn logic_set_as_state(
        &self,
        node: &SceneNode,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<NodeOutput, E2eError> {
        if let Some(next) = scene
            .edges
            .iter()
            .find(|e| e.source == node.id && e.source_handle == "next")
        {
            self.exec_node(&next.target, scene, nodes, cache)
        } else {
            Ok(NodeOutput::Text(config_string(
                &node.config,
                "valueString",
                "",
            )))
        }
    }

    fn render_image(
        &self,
        node: &SceneNode,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<DynamicImage, E2eError> {
        let mut target = self.default_canvas();
        if let Some(next_edge) = scene
            .edges
            .iter()
            .find(|e| e.source == node.id && e.source_handle == "next")
        {
            if let NodeOutput::Image(img) =
                self.exec_node(&next_edge.target, scene, nodes, cache)?
            {
                target = img;
            }
        }
        let source = self
            .find_input_image(&node.id, "fieldInput/image", scene, nodes, cache)?
            .or(self.find_input_image(&node.id, "fieldInput/inputImage", scene, nodes, cache)?)
            .unwrap_or_else(|| self.default_canvas());
        Ok(self.composite_image(target, source, node))
    }

    fn find_input_image(
        &self,
        node_id: &str,
        handle: &str,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<Option<DynamicImage>, E2eError> {
        if let Some(edge) = scene
            .edges
            .iter()
            .find(|edge| edge.target == node_id && edge.target_handle == handle)
        {
            if let NodeOutput::Image(img) = self.exec_node(&edge.source, scene, nodes, cache)? {
                return Ok(Some(img));
            }
        }
        Ok(None)
    }

    fn find_edge_input_value(
        &self,
        node_id: &str,
        handle: &str,
        scene: &E2eScene,
        nodes: &HashMap<String, SceneNode>,
        cache: &mut HashMap<String, NodeOutput>,
    ) -> Result<Option<String>, E2eError> {
        if let Some(edge) = scene
            .edges
            .iter()
            .find(|edge| edge.target == node_id && edge.target_handle == handle)
        {
            return Ok(Some(
                match self.exec_node(&edge.source, scene, nodes, cache)? {
                    NodeOutput::Text(t) => t,
                    NodeOutput::Bool(v) => v.to_string(),
                    NodeOutput::Image(_) => String::new(),
                },
            ));
        }
        Ok(None)
    }

    fn default_canvas(&self) -> DynamicImage {
        self.canvas_with_bg("#000000")
    }

    fn canvas_with_bg(&self, color: &str) -> DynamicImage {
        let rgba = parse_hex_color(color).unwrap_or([0, 0, 0, 255]);
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(self.width, self.height, Rgba(rgba)))
    }

    fn error_image(&self, _msg: &str) -> DynamicImage {
        let mut img = RgbaImage::from_pixel(self.width, self.height, Rgba([50, 0, 0, 255]));
        for i in 0..self.width.min(self.height) {
            img.put_pixel(i, i, Rgba([200, 0, 0, 255]));
        }
        DynamicImage::ImageRgba8(img)
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
        let angle = config_f32(&node.config, "angle", 45.0);

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
        let width = config_u32(&node.config, "width", self.width);
        let height = config_u32(&node.config, "height", self.height);
        let mut rgba = parse_hex_color(&config_string(&node.config, "color", "#000000"))
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
        let rel = path
            .trim_start_matches("./")
            .trim_start_matches("/assets/")
            .trim_start_matches("assets/");
        let full = self.assets_dir.join(rel);
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
                    (sw as f32 * scale).max(1.0) as u32,
                    (sh as f32 * scale).max(1.0) as u32,
                    FilterType::Lanczos3,
                )
            }
            "contain" => {
                let scale = (tw as f32 / sw as f32).min(th as f32 / sh as f32);
                source.resize(
                    (sw as f32 * scale).max(1.0) as u32,
                    (sh as f32 * scale).max(1.0) as u32,
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

fn config_string(config: &Map<String, Value>, key: &str, default: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}
fn config_i32(config: &Map<String, Value>, key: &str, default: i32) -> i32 {
    config
        .get(key)
        .and_then(|v| {
            v.as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .or_else(|| v.as_str().and_then(|s| s.parse::<i32>().ok()))
        })
        .unwrap_or(default)
}
fn config_u32(config: &Map<String, Value>, key: &str, default: u32) -> u32 {
    config
        .get(key)
        .and_then(|v| {
            v.as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .or_else(|| v.as_str().and_then(|s| s.parse::<u32>().ok()))
        })
        .unwrap_or(default)
}
fn config_f32(config: &Map<String, Value>, key: &str, default: f32) -> f32 {
    config
        .get(key)
        .and_then(|v| {
            v.as_f64()
                .map(|n| n as f32)
                .or_else(|| v.as_str().and_then(|s| s.parse::<f32>().ok()))
        })
        .unwrap_or(default)
}
fn config_bool(config: &Map<String, Value>, key: &str, default: bool) -> bool {
    config
        .get(key)
        .and_then(|v| {
            v.as_bool().or_else(|| {
                v.as_str()
                    .map(|s| s.eq_ignore_ascii_case("true") || s == "1")
            })
        })
        .unwrap_or(default)
}

fn parse_pair(v: &str, default: f32) -> (f32, f32) {
    let parts: Vec<f32> = v
        .split_whitespace()
        .filter_map(|p| p.parse::<f32>().ok())
        .collect();
    if parts.is_empty() {
        (default, default)
    } else if parts.len() == 1 {
        (parts[0], parts[0])
    } else {
        (parts[0], parts[1])
    }
}
fn parse_quad(v: &str, default: f32) -> (f32, f32, f32, f32) {
    let p: Vec<f32> = v
        .split_whitespace()
        .filter_map(|x| x.parse().ok())
        .collect();
    match p.len() {
        0 => (default, default, default, default),
        1 => (p[0], p[0], p[0], p[0]),
        2 => (p[0], p[1], p[0], p[1]),
        3 => (p[0], p[1], p[2], p[1]),
        _ => (p[0], p[1], p[2], p[3]),
    }
}
fn parse_ratio_list(v: &str, len: usize) -> Vec<f32> {
    let p: Vec<f32> = v
        .split_whitespace()
        .filter_map(|x| x.parse::<f32>().ok())
        .collect();
    if p.is_empty() {
        vec![1.0; len]
    } else {
        (0..len).map(|i| p[i % p.len()].max(0.0001)).collect()
    }
}
fn distribute(total: f32, ratios: &[f32]) -> Vec<u32> {
    let sum: f32 = ratios.iter().sum();
    ratios
        .iter()
        .map(|r| ((total * (*r) / sum).floor().max(1.0)) as u32)
        .collect()
}

fn scale_to_mode(source: DynamicImage, width: u32, height: u32, mode: &str) -> DynamicImage {
    match mode {
        "stretch" => source.resize_exact(width, height, FilterType::Lanczos3),
        "cover" => {
            let scale =
                (width as f32 / source.width() as f32).max(height as f32 / source.height() as f32);
            source.resize(
                (source.width() as f32 * scale) as u32,
                (source.height() as f32 * scale) as u32,
                FilterType::Lanczos3,
            )
        }
        "center" => {
            let mut out =
                DynamicImage::ImageRgba8(RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0])));
            let x = ((width as i64 - source.width() as i64) / 2).max(0);
            let y = ((height as i64 - source.height() as i64) / 2).max(0);
            image::imageops::overlay(&mut out, &source, x, y);
            out
        }
        _ => source.resize(width, height, FilterType::Lanczos3),
    }
}

fn load_font() -> Option<FontArc> {
    let candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ];
    for path in candidates {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(font) = FontArc::try_from_vec(bytes) {
                return Some(font);
            }
        }
    }
    None
}

fn fix_last_dimension(dimensions: &mut [u32], total: i32) {
    if dimensions.is_empty() {
        return;
    }
    let sum_except_last: i32 = dimensions[..dimensions.len() - 1]
        .iter()
        .map(|v| *v as i32)
        .sum();
    let last = (total - sum_except_last).max(1) as u32;
    let len = dimensions.len();
    dimensions[len - 1] = last;
}
