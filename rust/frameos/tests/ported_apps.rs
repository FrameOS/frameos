use frameos::apps::{execute_ported_app, AppExecutionContext, AppExecutionError, AppOutput};
use serde_json::{json, Map};

#[test]
fn pretty_json_respects_prettify_flag() {
    let mut fields = Map::new();
    fields.insert("json".to_string(), json!({"hello":"world"}));
    fields.insert("prettify".to_string(), json!(true));

    let output = execute_ported_app(
        "data/prettyJson",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect("pretty json app should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };
    assert!(rendered.contains('\n'));
    assert!(rendered.contains("  \"hello\""));
}

#[test]
fn next_sleep_duration_updates_context() {
    let mut fields = Map::new();
    fields.insert("duration".to_string(), json!(2.5));
    let mut context = AppExecutionContext::default();

    execute_ported_app("logic/nextSleepDuration", &fields, &mut context)
        .expect("nextSleepDuration should execute");

    assert_eq!(context.next_sleep_seconds, Some(2.5));
}

#[test]
fn break_if_rendering_errors_when_scene_is_busy() {
    let mut context = AppExecutionContext {
        is_rendering: true,
        ..AppExecutionContext::default()
    };

    let error = execute_ported_app("logic/breakIfRendering", &Map::new(), &mut context)
        .expect_err("busy rendering should abort app");

    assert!(matches!(error, AppExecutionError::Aborted(_)));
}

#[test]
fn set_as_state_rejects_dual_value_sources() {
    let mut fields = Map::new();
    fields.insert("stateKey".to_string(), json!("key"));
    fields.insert("valueString".to_string(), json!("text"));
    fields.insert("valueJson".to_string(), json!({"v": 1}));

    let error = execute_ported_app(
        "logic/setAsState",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect_err("dual value sources should fail");

    assert!(matches!(
        error,
        AppExecutionError::InvalidField {
            field: "valueString/valueJson",
            ..
        }
    ));
}

#[test]
fn xml_to_json_builds_document_tree() {
    let mut fields = Map::new();
    fields.insert(
        "xml".to_string(),
        json!("<root lang=\"en\"><title>Hello</title><!-- note --></root>"),
    );

    let output = execute_ported_app(
        "data/xmlToJson",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect("xml to json app should execute");

    let AppOutput::Value(payload) = output else {
        panic!("expected object output");
    };

    assert_eq!(payload["type"], json!("document"));
    assert_eq!(payload["root"]["type"], json!("element"));
    assert_eq!(payload["root"]["name"], json!("root"));
    assert_eq!(payload["root"]["attributes"]["lang"], json!("en"));
    assert_eq!(payload["root"]["children"][0]["name"], json!("title"));
    assert_eq!(payload["root"]["children"][1]["type"], json!("comment"));
}

#[test]
fn xml_to_json_rejects_invalid_xml() {
    let mut fields = Map::new();
    fields.insert("xml".to_string(), json!("<root>"));

    let error = execute_ported_app(
        "data/xmlToJson",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect_err("invalid xml should fail");

    assert!(matches!(
        error,
        AppExecutionError::InvalidField { field: "xml", .. }
    ));
}
