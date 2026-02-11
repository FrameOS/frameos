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
fn pretty_json_uses_ident_width() {
    let mut fields = Map::new();
    fields.insert("json".to_string(), json!({"hello":"world"}));
    fields.insert("prettify".to_string(), json!(true));
    fields.insert("ident".to_string(), json!(4));

    let output = execute_ported_app(
        "data/prettyJson",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect("pretty json app should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };
    assert!(rendered.contains("\n    \"hello\""));
}

#[test]
fn pretty_json_rejects_negative_ident() {
    let mut fields = Map::new();
    fields.insert("json".to_string(), json!({"hello":"world"}));
    fields.insert("prettify".to_string(), json!(true));
    fields.insert("ident".to_string(), json!(-1));

    let error = execute_ported_app(
        "data/prettyJson",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect_err("negative ident should fail");

    assert!(matches!(
        error,
        AppExecutionError::InvalidField { field: "ident", .. }
    ));
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

#[test]
fn events_to_agenda_formats_and_sorts_events() {
    let mut fields = Map::new();
    fields.insert(
        "events".to_string(),
        json!([
            {"summary": "Holiday", "startTime": "2024-12-25", "endTime": "2024-12-25"},
            {"summary": "Breakfast", "startTime": "2024-12-24T08:00:00", "endTime": "2024-12-24T09:00:00"}
        ]),
    );
    fields.insert("baseFontSize".to_string(), json!(24.0));
    fields.insert("titleFontSize".to_string(), json!(48.0));
    fields.insert("textColor".to_string(), json!("#445566"));
    fields.insert("timeColor".to_string(), json!("#778899"));
    fields.insert("titleColor".to_string(), json!("#112233"));
    fields.insert("startWithToday".to_string(), json!(false));

    let output = execute_ported_app(
        "data/eventsToAgenda",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect("eventsToAgenda should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };

    assert!(rendered.contains("^(48,#112233)Tuesday, December 24"));
    assert!(rendered.contains("^(24,#778899)08:00 - 09:00  ^(24,#445566)Breakfast"));
    assert!(rendered.contains("^(48,#112233)Wednesday, December 25"));
    assert!(rendered.contains("^(24,#778899)All day  ^(24,#445566)Holiday"));
    assert!(rendered.find("Breakfast") < rendered.find("Holiday"));
}

#[test]
fn events_to_agenda_shows_until_for_multi_day_events() {
    let mut fields = Map::new();
    fields.insert(
        "events".to_string(),
        json!([
            {"summary": "Conference", "startTime": "2024-12-25", "endTime": "2024-12-27"}
        ]),
    );
    fields.insert("baseFontSize".to_string(), json!(24.0));
    fields.insert("titleFontSize".to_string(), json!(48.0));
    fields.insert("textColor".to_string(), json!("#445566"));
    fields.insert("timeColor".to_string(), json!("#778899"));
    fields.insert("titleColor".to_string(), json!("#112233"));
    fields.insert("startWithToday".to_string(), json!(false));

    let output = execute_ported_app(
        "data/eventsToAgenda",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect("eventsToAgenda should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };

    assert!(rendered.contains("^(48,#112233)Wednesday, December 25"));
    assert!(rendered.contains("^(24,#778899)Until Friday, December 27  ^(24,#445566)Conference"));
}

#[test]
fn events_to_agenda_includes_today_for_ongoing_event() {
    let mut fields = Map::new();
    fields.insert(
        "events".to_string(),
        json!([
            {"summary": "Retreat", "startTime": "2024-12-23", "endTime": "2024-12-27"}
        ]),
    );
    fields.insert("baseFontSize".to_string(), json!(24.0));
    fields.insert("titleFontSize".to_string(), json!(48.0));
    fields.insert("textColor".to_string(), json!("#445566"));
    fields.insert("timeColor".to_string(), json!("#778899"));
    fields.insert("titleColor".to_string(), json!("#112233"));
    fields.insert("startWithToday".to_string(), json!(true));
    fields.insert("testOverrideToday".to_string(), json!("2024-12-26"));

    let output = execute_ported_app(
        "data/eventsToAgenda",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect("eventsToAgenda should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };

    assert!(!rendered.contains("No events today"));
    assert_eq!(
        rendered
            .matches("^(48,#112233)Thursday, December 26")
            .count(),
        1
    );
    assert!(rendered.contains("^(24,#778899)Until Friday, December 27  ^(24,#445566)Retreat"));
}

#[test]
fn events_to_agenda_handles_dst_boundary_times() {
    let mut fields = Map::new();
    fields.insert(
        "events".to_string(),
        json!([
            {
                "summary": "DST Change",
                "startTime": "2024-03-10T01:30:00-08:00",
                "endTime": "2024-03-10T03:30:00-07:00",
                "timezone": "America/Los_Angeles"
            }
        ]),
    );
    fields.insert("startWithToday".to_string(), json!(false));

    let output = execute_ported_app(
        "data/eventsToAgenda",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect("eventsToAgenda should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };

    assert!(rendered.contains("Sunday, March 10"));
    assert!(rendered.contains("01:30 - 03:30"));
}

#[test]
fn events_to_agenda_prefers_event_timezone_over_context_fallback() {
    let mut fields = Map::new();
    fields.insert(
        "events".to_string(),
        json!([
            {
                "summary": "Meeting",
                "startTime": "2024-05-01T09:00:00",
                "endTime": "2024-05-01T10:00:00",
                "timezone": "UTC"
            }
        ]),
    );
    fields.insert("startWithToday".to_string(), json!(false));

    let mut context = AppExecutionContext::default();
    context.time_zone = Some("Definitely/Invalid".to_string());

    let output = execute_ported_app("data/eventsToAgenda", &fields, &mut context)
        .expect("event timezone should take precedence over invalid fallback");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };
    assert!(rendered.contains("09:00 - 10:00"));
}

#[test]
fn clock_formats_time_with_standard_pattern() {
    let mut fields = Map::new();
    fields.insert("format".to_string(), json!("yyyy-MM-dd HH:mm:ss"));
    fields.insert("testOverrideNow".to_string(), json!("2024-06-07T08:09:10Z"));

    let mut context = AppExecutionContext::default();
    context.time_zone = Some("UTC".to_string());

    let output =
        execute_ported_app("data/clock", &fields, &mut context).expect("clock app should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };
    assert_eq!(rendered, "2024-06-07 08:09:10");
}

#[test]
fn clock_supports_custom_format() {
    let mut fields = Map::new();
    fields.insert("format".to_string(), json!("custom"));
    fields.insert("formatCustom".to_string(), json!("HH:mm"));
    fields.insert("testOverrideNow".to_string(), json!("2024-06-07T08:09:10Z"));

    let mut context = AppExecutionContext::default();
    context.time_zone = Some("UTC".to_string());

    let output =
        execute_ported_app("data/clock", &fields, &mut context).expect("clock app should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };
    assert_eq!(rendered, "08:09");
}

#[test]
fn clock_applies_context_timezone() {
    let mut fields = Map::new();
    fields.insert("format".to_string(), json!("HH:mm"));
    fields.insert("testOverrideNow".to_string(), json!("2024-01-15T12:00:00Z"));

    let mut context = AppExecutionContext::default();
    context.time_zone = Some("America/New_York".to_string());

    let output =
        execute_ported_app("data/clock", &fields, &mut context).expect("clock app should execute");

    let AppOutput::Value(serde_json::Value::String(rendered)) = output else {
        panic!("expected string output");
    };
    assert_eq!(rendered, "07:00");
}

#[test]
fn clock_rejects_invalid_override_datetime() {
    let mut fields = Map::new();
    fields.insert("format".to_string(), json!("HH:mm"));
    fields.insert("testOverrideNow".to_string(), json!("not-a-datetime"));

    let error = execute_ported_app("data/clock", &fields, &mut AppExecutionContext::default())
        .expect_err("invalid override datetime should fail");

    assert!(matches!(
        error,
        AppExecutionError::InvalidField {
            field: "testOverrideNow",
            ..
        }
    ));
}

#[test]
fn ical_json_rejects_url_input() {
    let mut fields = Map::new();
    fields.insert(
        "ical".to_string(),
        json!("https://example.com/calendar.ics"),
    );

    let error = execute_ported_app(
        "data/icalJson",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect_err("url input should be rejected");

    assert!(matches!(
        error,
        AppExecutionError::InvalidField { field: "ical", .. }
    ));
}

#[test]
fn ical_json_exports_recurring_and_all_day_events() {
    let mut fields = Map::new();
    fields.insert(
        "ical".to_string(),
        json!(
            "BEGIN:VCALENDAR\nX-WR-TIMEZONE:Europe/Brussels\nBEGIN:VEVENT\nDTSTART;TZID=Europe/Brussels:20240103T170000\nDTEND;TZID=Europe/Brussels:20240103T173000\nRRULE:FREQ=WEEKLY;COUNT=3;BYDAY=WE\nSUMMARY:Team Standup\nLOCATION:https://example.com/location-url/\nDESCRIPTION:Recurring sync\nURL:https://example.com/standup\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20240110\nDTEND;VALUE=DATE:20240111\nSUMMARY:Company Holiday\nEND:VEVENT\nEND:VCALENDAR"
        ),
    );
    fields.insert("exportFrom".to_string(), json!("2024-01-01"));
    fields.insert("exportUntil".to_string(), json!("2024-01-31"));
    fields.insert("exportCount".to_string(), json!(10));
    fields.insert("addLocation".to_string(), json!(true));
    fields.insert("addUrl".to_string(), json!(true));
    fields.insert("addDescription".to_string(), json!(true));
    fields.insert("addTimezone".to_string(), json!(true));

    let mut context = AppExecutionContext::default();
    context.time_zone = Some("UTC".to_string());

    let output = execute_ported_app("data/icalJson", &fields, &mut context)
        .expect("ical json should execute");

    let AppOutput::Value(serde_json::Value::Array(events)) = output else {
        panic!("expected array output");
    };

    assert_eq!(events.len(), 4);

    let standups = events
        .iter()
        .filter(|event| event["summary"] == json!("Team Standup"))
        .collect::<Vec<_>>();
    assert_eq!(standups.len(), 3);
    assert_eq!(standups[0]["startTime"], json!("2024-01-03T17:00:00"));
    assert_eq!(standups[1]["startTime"], json!("2024-01-10T17:00:00"));
    assert_eq!(standups[2]["startTime"], json!("2024-01-17T17:00:00"));
    assert_eq!(
        standups[0]["location"],
        json!("https://example.com/location-url/")
    );
    assert_eq!(standups[0]["url"], json!("https://example.com/standup"));
    assert_eq!(standups[0]["description"], json!("Recurring sync"));

    let holiday = events
        .iter()
        .find(|event| event["summary"] == json!("Company Holiday"))
        .expect("holiday event should exist");
    assert_eq!(holiday["startTime"], json!("2024-01-10"));
    assert_eq!(holiday["endTime"], json!("2024-01-10"));
    assert_eq!(holiday["timezone"], json!("Europe/Brussels"));
}

#[test]
fn ical_json_supports_search_filtering() {
    let mut fields = Map::new();
    fields.insert(
        "ical".to_string(),
        json!(
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20240103T100000Z\nDTEND:20240103T103000Z\nSUMMARY:Standup\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20240103T110000Z\nDTEND:20240103T113000Z\nSUMMARY:Design Review\nEND:VEVENT\nEND:VCALENDAR"
        ),
    );
    fields.insert("exportFrom".to_string(), json!("2024-01-01"));
    fields.insert("exportUntil".to_string(), json!("2024-01-31"));
    fields.insert("search".to_string(), json!("stand"));

    let output = execute_ported_app(
        "data/icalJson",
        &fields,
        &mut AppExecutionContext::default(),
    )
    .expect("ical json should execute");

    let AppOutput::Value(serde_json::Value::Array(events)) = output else {
        panic!("expected array output");
    };

    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["summary"], json!("Standup"));
}
