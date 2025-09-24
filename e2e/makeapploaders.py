from glob import glob
import os

# use dynamic imports to import ../backend/app/codegen/app_loader_nim.py
import importlib.util
spec = importlib.util.spec_from_file_location("app_loader_nim", os.path.join(os.path.dirname(__file__), "../backend/app/codegen/app_loader_nim.py"))
assert spec is not None
assert spec.loader is not None
app_loader_nim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app_loader_nim)
write_app_loader_nim = app_loader_nim.write_app_loader_nim

def main():
    tmp_dir = os.environ.get("FRAMEOS_ROOT_DIR", "frameos")
    source_dir = os.path.abspath(tmp_dir)

    os.makedirs(os.path.join(source_dir, "src", "apps"), exist_ok=True)
    for app_dir in glob(os.path.join(source_dir, "src", "apps", "*", "*")):
        config_path = os.path.join(app_dir, "config.json")
        if os.path.exists(config_path):
            app_loader_nim = write_app_loader_nim(app_dir)
            with open(os.path.join(app_dir, "__loader.nim"), "w") as lf:
                lf.write(app_loader_nim)

if __name__ == "__main__":
    main()
