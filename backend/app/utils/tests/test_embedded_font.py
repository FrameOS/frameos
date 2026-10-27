from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# The default font compiled into every runtime is the original
# (frameos/assets/copied/fonts/Ubuntu-Regular.ttf) without the tables pixie
# never reads. frameos/tools/generate_embedded_font.py makes it; its --check
# reads both the way pixie does and refuses any drawn difference.

REPO_ROOT = Path(__file__).resolve().parents[4]
GENERATOR = REPO_ROOT / "frameos" / "tools" / "generate_embedded_font.py"


def test_embedded_font_draws_like_the_original():
    result = subprocess.run([sys.executable, str(GENERATOR), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
