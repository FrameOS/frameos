use serde_json::{Map, Value};

use crate::models::AppDescriptor;

/// Execution context shared across app invocations.
#[derive(Debug, Clone, PartialEq)]
pub struct AppExecutionContext {
    pub state: Map<String, Value>,
    pub is_rendering: bool,
    pub next_sleep_seconds: Option<f64>,
}

impl Default for AppExecutionContext {
    fn default() -> Self {
        Self {
            state: Map::new(),
            is_rendering: false,
            next_sleep_seconds: None,
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
    InvalidField {
        field: &'static str,
        reason: &'static str,
    },
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
        serde_json::to_string_pretty(json_value).map_err(|_| AppExecutionError::InvalidField {
            field: "json",
            reason: "value cannot be rendered as json",
        })?
    } else {
        json_value.to_string()
    };

    Ok(AppOutput::Value(Value::String(output)))
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
            reason: "only one of valueString or valueJson can be set",
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
            reason: "must be >= 0",
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
