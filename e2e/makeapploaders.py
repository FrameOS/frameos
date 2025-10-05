from glob import glob
import os

# use dynamic imports to import ../backend/app/codegen/app_loader_nim.py
import importlib.util
app_loader_spec = importlib.util.spec_from_file_location("app_loader_nim", os.path.join(os.path.dirname(__file__), "../backend/app/codegen/app_loader_nim.py"))
assert app_loader_spec is not None
assert app_loader_spec.loader is not None
app_loader_nim = importlib.util.module_from_spec(app_loader_spec)
app_loader_spec.loader.exec_module(app_loader_nim)
write_app_loader_nim = app_loader_nim.write_app_loader_nim

apps_spec = importlib.util.spec_from_file_location("apps_nim", os.path.join(os.path.dirname(__file__), "../backend/app/codegen/apps_nim.py"))
assert apps_spec is not None
assert apps_spec.loader is not None
apps_nim = importlib.util.module_from_spec(apps_spec)
apps_spec.loader.exec_module(apps_nim)
write_apps_nim = apps_nim.write_apps_nim

def main():
    tmp_dir = os.environ.get("FRAMEOS_ROOT_DIR", "frameos")
    source_dir = os.path.abspath(tmp_dir)

    os.makedirs(os.path.join(source_dir, "src", "apps"), exist_ok=True)
    for app_dir in glob(os.path.join(source_dir, "src", "apps", "*", "*")):
        config_path = os.path.join(app_dir, "config.json")
        if os.path.exists(config_path):
            app_loader_nim = write_app_loader_nim(app_dir)
            with open(os.path.join(app_dir, "app_loader.nim"), "w") as lf:
                lf.write(app_loader_nim)

    # write apps.nim
    with open(os.path.join(source_dir, "src", "apps", "apps.nim"), "w") as lf:
        lf.write(write_apps_nim())

if __name__ == "__main__":
    main()
