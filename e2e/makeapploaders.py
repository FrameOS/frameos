from pathlib import Path
import runpy


runpy.run_path(str(Path(__file__).resolve().parents[1] / "frameos" / "tools" / "makeapploaders.py"), run_name="__main__")
