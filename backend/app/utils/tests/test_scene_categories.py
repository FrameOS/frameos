import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]


def test_generated_tables_are_current():
    """docs/scene-categories.json is the one list of scene categories: the
    runtime's table, the SPA's and the cloud store's are written from it."""
    generator = REPO_ROOT / "frameos" / "tools" / "generate_scene_categories.py"
    result = subprocess.run(["python3", str(generator), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_every_category_has_a_short_name():
    categories = json.loads((REPO_ROOT / "docs" / "scene-categories.json").read_text())["categories"]
    ids = [category["id"] for category in categories]
    assert len(ids) == len(set(ids))
    for category in categories:
        # A folder's label: shorter than the store shelf's title, or the same.
        assert 0 < len(category["name"]) <= len(category["title"])
