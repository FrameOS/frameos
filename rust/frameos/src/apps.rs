use std::fmt::Write;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use serde_json::{Map, Value};
use xmltree::{Element, XMLNode};

use crate::models::AppDescriptor;

/// Execution context shared across app invocations.
#[derive(Debug, Clone, PartialEq)]
pub struct AppExecutionContext {
    pub state: Map<String, Value>,
    pub is_rendering: bool,
    pub next_sleep_seconds: Option<f64>,
    pub time_zone: Option<String>,
}

impl Default for AppExecutionContext {
    fn default() -> Self {
        Self {
            state: Map::new(),
            is_rendering: false,
            next_sleep_seconds: None,
            time_zone: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AppOutput {
    Value(Value),
    BranchNode(u64),
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppExecutionError {
    UnknownKeyword(String),
    MissingField(&'static str),
    InvalidField { field: &'static str, reason: String },
    JsonParse(String),
    Aborted(String),
}

impl std::fmt::Display for AppExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownKeyword(keyword) => write!(f, "unknown app keyword: {keyword}"),
            Self::MissingField(field) => write!(f, "missing required app field: {field}"),
            Self::InvalidField { field, reason } => {
                write!(f, "invalid app field `{field}`: {reason}")
            }
            Self::JsonParse(error) => write!(f, "failed to parse json: {error}"),
            Self::Aborted(reason) => write!(f, "app execution aborted: {reason}"),
        }
    }
}

impl std::error::Error for AppExecutionError {}

/// In-memory application registry placeholder.
#[derive(Debug, Default)]
pub struct AppRegistry {
    apps: Vec<AppDescriptor>,
}

impl AppRegistry {
    pub fn with_apps(apps: Vec<AppDescriptor>) -> Self {
        Self { apps }
    }

    pub fn apps(&self) -> &[AppDescriptor] {
        &self.apps
    }
}

pub fn execute_ported_app(
    keyword: &str,
    fields: &Map<String, Value>,
    context: &mut AppExecutionContext,
) -> Result<AppOutput, AppExecutionError> {
    match keyword {
        "data/parseJson" => execute_data_parse_json(fields),
        "data/prettyJson" => execute_data_pretty_json(fields),
        "data/xmlToJson" => execute_data_xml_to_json(fields),
        "data/eventsToAgenda" => execute_data_events_to_agenda(fields, context),
        "logic/setAsState" => execute_logic_set_as_state(fields, context),
        "logic/ifElse" => execute_logic_if_else(fields),
        "logic/nextSleepDuration" => execute_logic_next_sleep_duration(fields, context),
        "logic/breakIfRendering" => execute_logic_break_if_rendering(context),
        _ => Err(AppExecutionError::UnknownKeyword(keyword.to_string())),
    }
}

fn require_string<'a>(
    fields: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, AppExecutionError> {
    fields
        .get(field)
        .and_then(Value::as_str)
        .ok_or(AppExecutionError::MissingField(field))
}

fn require_f64(fields: &Map<String, Value>, field: &'static str) -> Result<f64, AppExecutionError> {
    fields
        .get(field)
        .and_then(Value::as_f64)
        .ok_or(AppExecutionError::MissingField(field))
}

fn execute_data_parse_json(fields: &Map<String, Value>) -> Result<AppOutput, AppExecutionError> {
    let text = require_string(fields, "text")?;
    let parsed: Value = serde_json::from_str(text)
        .map_err(|error| AppExecutionError::JsonParse(error.to_string()))?;
    Ok(AppOutput::Value(parsed))
}

fn execute_data_pretty_json(fields: &Map<String, Value>) -> Result<AppOutput, AppExecutionError> {
    let json_value = fields
        .get("json")
        .ok_or(AppExecutionError::MissingField("json"))?;
    let prettify = fields
        .get("prettify")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let output = if prettify {
        let ident = fields.get("ident").and_then(Value::as_i64).unwrap_or(2);
        if ident < 0 {
            return Err(AppExecutionError::InvalidField {
                field: "ident",
                reason: "must be >= 0".to_string(),
            });
        }

        let indent = vec![b' '; ident as usize];
        let formatter = serde_json::ser::PrettyFormatter::with_indent(&indent);
        let mut serializer = serde_json::Serializer::with_formatter(Vec::new(), formatter);
        json_value
            .serialize(&mut serializer)
            .map_err(|_| AppExecutionError::InvalidField {
                field: "json",
                reason: "value cannot be rendered as json".to_string(),
            })?;
        String::from_utf8(serializer.into_inner()).map_err(|error| {
            AppExecutionError::InvalidField {
                field: "json",
                reason: format!("encoded json is not utf-8: {error}"),
            }
        })?
    } else {
        json_value.to_string()
    };

    Ok(AppOutput::Value(Value::String(output)))
}

fn execute_data_xml_to_json(fields: &Map<String, Value>) -> Result<AppOutput, AppExecutionError> {
    let xml = require_string(fields, "xml")?;
    let document =
        Element::parse(xml.as_bytes()).map_err(|error| AppExecutionError::InvalidField {
            field: "xml",
            reason: format!("failed to parse xml: {error}"),
        })?;

    let root = xml_node_to_json_element(&document);
    Ok(AppOutput::Value(serde_json::json!({
        "type": "document",
        "root": root,
    })))
}

fn execute_data_events_to_agenda(
    fields: &Map<String, Value>,
    context: &AppExecutionContext,
) -> Result<AppOutput, AppExecutionError> {
    let events = fields
        .get("events")
        .and_then(Value::as_array)
        .ok_or(AppExecutionError::MissingField("events"))?;

    let base_font_size = fields
        .get("baseFontSize")
        .and_then(Value::as_f64)
        .unwrap_or(24.0);
    let title_font_size = fields
        .get("titleFontSize")
        .and_then(Value::as_f64)
        .unwrap_or(48.0);
    let text_color = normalize_hex_color(
        fields
            .get("textColor")
            .and_then(Value::as_str)
            .unwrap_or("#FFFFFF"),
        "textColor",
    )?;
    let time_color = normalize_hex_color(
        fields
            .get("timeColor")
            .and_then(Value::as_str)
            .unwrap_or("#FF0000"),
        "timeColor",
    )?;
    let title_color = normalize_hex_color(
        fields
            .get("titleColor")
            .and_then(Value::as_str)
            .unwrap_or("#FFFFFF"),
        "titleColor",
    )?;
    let start_with_today = fields
        .get("startWithToday")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let title = format!("^({},{})", format_font_size(title_font_size), title_color);
    let normal = format!("^({},{})", format_font_size(base_font_size), text_color);
    let time = format!("^({},{})", format_font_size(base_font_size), time_color);

    let timezone = get_timezone(events, context.time_zone.as_deref())?;
    let today = fields
        .get("testOverrideToday")
        .and_then(Value::as_str)
        .map(|raw| parse_date(raw, "testOverrideToday"))
        .transpose()?
        .unwrap_or_else(|| Utc::now().with_timezone(&timezone).date_naive());

    let mut output = String::new();
    let mut current_day = String::new();
    let no_events = events.is_empty();

    if start_with_today || no_events {
        output.push_str(&format!(
            "{}{title_day}\n{}\n",
            title,
            normal,
            title_day = format_day(today)
        ));
        current_day = format_iso_day(today);
    }

    if no_events {
        output.push_str("No events found\n");
        return Ok(AppOutput::Value(Value::String(output)));
    }

    let mut sorted_events = events.to_vec();
    sorted_events.sort_by(|a, b| {
        event_start_time(a)
            .unwrap_or_default()
            .cmp(event_start_time(b).unwrap_or_default())
    });

    let mut has_any = false;

    for event in sorted_events {
        let summary = event
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let start_day = event.get("startTime").and_then(Value::as_str).ok_or(
            AppExecutionError::InvalidField {
                field: "events.startTime",
                reason: "missing or non-string startTime".to_string(),
            },
        )?;
        let end_day = event.get("endTime").and_then(Value::as_str).ok_or(
            AppExecutionError::InvalidField {
                field: "events.endTime",
                reason: "missing or non-string endTime".to_string(),
            },
        )?;

        let with_time = start_day.contains('T');
        let start_date = split_iso_day(start_day)?;
        let end_date = split_iso_day(end_day)?;

        let mut display_day = start_date.clone();
        if start_with_today
            && !current_day.is_empty()
            && start_date <= current_day
            && current_day <= end_date
        {
            display_day = current_day.clone();
        }

        if display_day != current_day {
            if !has_any && start_with_today {
                output.push_str("No events today\n");
            }
            output.push_str("\n");
            output.push_str(&format!(
                "{}{title_day}\n{}\n",
                title,
                normal,
                title_day = format_day(parse_date(&display_day, "events.startTime")?)
            ));
            current_day = display_day.clone();
        }

        has_any = true;

        if with_time {
            let start_time = extract_hh_mm(start_day)?;
            let end_time = extract_hh_mm(end_day)?;
            writeln!(output, "{time}{start_time} - {end_time}  {normal}{summary}")
                .expect("write to string cannot fail");
        } else if start_day == current_day && end_day == current_day {
            writeln!(output, "{time}All day  {normal}{summary}")
                .expect("write to string cannot fail");
        } else {
            let end_title = format_day(parse_date(&end_date, "events.endTime")?);
            writeln!(output, "{time}Until {end_title}  {normal}{summary}")
                .expect("write to string cannot fail");
        }
    }

    Ok(AppOutput::Value(Value::String(output)))
}

fn get_timezone(events: &[Value], fallback: Option<&str>) -> Result<Tz, AppExecutionError> {
    for event in events {
        if let Some(timezone_name) = event.get("timezone").and_then(Value::as_str) {
            if !timezone_name.is_empty() {
                return timezone_name
                    .parse::<Tz>()
                    .map_err(|_| AppExecutionError::InvalidField {
                        field: "events.timezone",
                        reason: format!("unknown timezone `{timezone_name}`"),
                    });
            }
        }
    }

    let timezone_name = fallback.unwrap_or("UTC");
    timezone_name
        .parse::<Tz>()
        .map_err(|_| AppExecutionError::InvalidField {
            field: "timeZone",
            reason: format!("unknown timezone `{timezone_name}`"),
        })
}

fn parse_date(raw: &str, field: &'static str) -> Result<NaiveDate, AppExecutionError> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| AppExecutionError::InvalidField {
        field,
        reason: format!("expected YYYY-MM-DD date, got `{raw}`"),
    })
}

fn split_iso_day(raw: &str) -> Result<String, AppExecutionError> {
    let day = raw.split('T').next().unwrap_or_default().to_string();
    parse_date(&day, "events.startTime")?;
    Ok(day)
}

fn extract_hh_mm(raw: &str) -> Result<String, AppExecutionError> {
    let Some((_, time_part)) = raw.split_once('T') else {
        return Err(AppExecutionError::InvalidField {
            field: "events.startTime",
            reason: format!("expected datetime with T separator, got `{raw}`"),
        });
    };

    if let Ok(date_time) = DateTime::parse_from_rfc3339(raw) {
        return Ok(date_time.format("%H:%M").to_string());
    }

    if let Ok(date_time) = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S") {
        return Ok(date_time.format("%H:%M").to_string());
    }

    if let Ok(date_time) = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M") {
        return Ok(date_time.format("%H:%M").to_string());
    }

    let trimmed = time_part.get(0..5).unwrap_or_default();
    if trimmed.len() == 5 && trimmed.chars().nth(2) == Some(':') {
        return Ok(trimmed.to_string());
    }

    Err(AppExecutionError::InvalidField {
        field: "events.startTime",
        reason: format!("unable to parse time from `{raw}`"),
    })
}

fn event_start_time(value: &Value) -> Option<&str> {
    value.get("startTime")?.as_str()
}

fn format_day(day: NaiveDate) -> String {
    day.format("%A, %B %-d").to_string()
}

fn format_iso_day(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}

fn normalize_hex_color(raw: &str, field: &'static str) -> Result<String, AppExecutionError> {
    let Some(hex) = raw.strip_prefix('#') else {
        return Err(AppExecutionError::InvalidField {
            field,
            reason: "expected #RRGGBB format".to_string(),
        });
    };

    if hex.len() != 6 || !hex.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(AppExecutionError::InvalidField {
            field,
            reason: "expected #RRGGBB format".to_string(),
        });
    }

    Ok(format!("#{}", hex.to_uppercase()))
}

fn format_font_size(value: f64) -> String {
    let mut formatted = format!("{value:.6}");
    while formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    if formatted.is_empty() {
        "0".to_string()
    } else {
        formatted
    }
}

fn xml_node_to_json_element(node: &Element) -> Value {
    let children = node
        .children
        .iter()
        .filter_map(xml_child_to_json)
        .collect::<Vec<_>>();

    serde_json::json!({
        "type": "element",
        "name": node.name,
        "attributes": node.attributes,
        "children": children,
    })
}

fn xml_child_to_json(child: &XMLNode) -> Option<Value> {
    match child {
        XMLNode::Element(element) => Some(xml_node_to_json_element(element)),
        XMLNode::Text(text) => {
            if text.trim().is_empty() {
                None
            } else {
                Some(serde_json::json!({"type":"text", "text": text}))
            }
        }
        XMLNode::CData(text) => Some(serde_json::json!({"type":"cdata", "text": text})),
        XMLNode::Comment(text) => Some(serde_json::json!({"type":"comment", "text": text})),
        XMLNode::ProcessingInstruction(name, value) => {
            let text = value.clone().unwrap_or_default();
            Some(serde_json::json!({"type":"entity", "text": format!("{name} {text}").trim()}))
        }
    }
}

fn execute_logic_set_as_state(
    fields: &Map<String, Value>,
    context: &mut AppExecutionContext,
) -> Result<AppOutput, AppExecutionError> {
    let state_key = require_string(fields, "stateKey")?;
    let value_string = fields.get("valueString").and_then(Value::as_str);
    let value_json = fields.get("valueJson").filter(|value| !value.is_null());

    if value_string.is_some() && value_json.is_some() {
        return Err(AppExecutionError::InvalidField {
            field: "valueString/valueJson",
            reason: "only one of valueString or valueJson can be set".to_string(),
        });
    }

    if let Some(value) = value_json {
        context.state.insert(state_key.to_string(), value.clone());
    } else if let Some(value) = value_string {
        context
            .state
            .insert(state_key.to_string(), Value::String(value.to_string()));
    }

    Ok(AppOutput::Empty)
}

fn execute_logic_if_else(fields: &Map<String, Value>) -> Result<AppOutput, AppExecutionError> {
    let condition = fields
        .get("condition")
        .and_then(Value::as_bool)
        .ok_or(AppExecutionError::MissingField("condition"))?;

    let branch_field = if condition { "thenNode" } else { "elseNode" };
    let Some(node_id) = fields.get(branch_field).and_then(Value::as_u64) else {
        return Ok(AppOutput::Empty);
    };

    if node_id == 0 {
        return Ok(AppOutput::Empty);
    }

    Ok(AppOutput::BranchNode(node_id))
}

fn execute_logic_next_sleep_duration(
    fields: &Map<String, Value>,
    context: &mut AppExecutionContext,
) -> Result<AppOutput, AppExecutionError> {
    let duration = require_f64(fields, "duration")?;
    if duration < 0.0 {
        return Err(AppExecutionError::InvalidField {
            field: "duration",
            reason: "must be >= 0".to_string(),
        });
    }

    context.next_sleep_seconds = Some(duration);
    Ok(AppOutput::Empty)
}

fn execute_logic_break_if_rendering(
    context: &AppExecutionContext,
) -> Result<AppOutput, AppExecutionError> {
    if context.is_rendering {
        return Err(AppExecutionError::Aborted(
            "aborting run because scene is rendering".to_string(),
        ));
    }

    Ok(AppOutput::Empty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_app_returns_json_payload() {
        let mut fields = Map::new();
        fields.insert("text".to_string(), serde_json::json!("{\"value\":42}"));

        let output = execute_ported_app(
            "data/parseJson",
            &fields,
            &mut AppExecutionContext::default(),
        )
        .expect("parse json app should execute");
        assert_eq!(output, AppOutput::Value(serde_json::json!({"value": 42})));
    }

    #[test]
    fn set_as_state_writes_json_value() {
        let mut fields = Map::new();
        fields.insert("stateKey".to_string(), serde_json::json!("temperature"));
        fields.insert("valueJson".to_string(), serde_json::json!({"c": 21.2}));
        let mut context = AppExecutionContext::default();

        let output = execute_ported_app("logic/setAsState", &fields, &mut context)
            .expect("setAsState should execute");

        assert_eq!(output, AppOutput::Empty);
        assert_eq!(
            context.state.get("temperature"),
            Some(&serde_json::json!({"c": 21.2}))
        );
    }

    #[test]
    fn if_else_returns_selected_branch() {
        let mut fields = Map::new();
        fields.insert("condition".to_string(), serde_json::json!(true));
        fields.insert("thenNode".to_string(), serde_json::json!(12));
        fields.insert("elseNode".to_string(), serde_json::json!(99));

        let output =
            execute_ported_app("logic/ifElse", &fields, &mut AppExecutionContext::default())
                .expect("ifElse should execute");

        assert_eq!(output, AppOutput::BranchNode(12));
    }
}
