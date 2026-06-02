from app.utils.ai_catalog import build_catalog_context, collect_catalog_items


def test_collect_catalog_items_lists_apps_and_scene_examples():
    items = collect_catalog_items({"openAI": {"apiKey": "key"}, "unsplash": {"accessKey": "key"}})
    source_paths = {item.source_path for item in items}

    assert "frameos/src/apps/render/text" in source_paths
    assert "frameos/src/apps/render/image" in source_paths
    assert "repo/scenes/samples/XKCD" in source_paths


def test_collect_catalog_items_filters_apps_with_missing_service_settings():
    items = collect_catalog_items({})
    keywords = {item.metadata_json.get("keyword") for item in items if item.source_type == "app"}

    assert "data/openaiText" not in keywords
    assert "data/unsplash" not in keywords
    assert "render/text" in keywords


def test_build_catalog_context_includes_full_list_and_default_details():
    items = collect_catalog_items({"openAI": {"apiKey": "key"}, "unsplash": {"accessKey": "key"}})
    context, details = build_catalog_context(items, query="show an xkcd comic with title text")

    assert "FrameOS catalog lookup tool" in context
    assert "render/text" in context
    assert "repo/scenes/samples/XKCD" in context
    assert any(item.source_path == "repo/scenes/samples/XKCD" for item in details)
    assert any(item.source_path == "frameos/src/apps/render/text" for item in details)
