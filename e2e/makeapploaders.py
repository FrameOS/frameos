from glob import glob
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../backend"))

# use dynamic imports to import ../backend/app/codegen/app_loader_nim.py
import importlib.util
app_loader_spec = importlib.util.spec_from_file_location("app_loader_nim", os.path.join(os.path.dirname(__file__), "../backend/app/codegen/app_loader_nim.py"))
assert app_loader_spec is not None
assert app_loader_spec.loader is not None
app_loader_nim = importlib.util.module_from_spec(app_loader_spec)
app_loader_spec.loader.exec_module(app_loader_nim)
write_app_loader_nim = app_loader_nim.write_app_loader_nim
write_js_app_nim = app_loader_nim.write_js_app_nim

apps_spec = importlib.util.spec_from_file_location("apps_nim", os.path.join(os.path.dirname(__file__), "../backend/app/codegen/apps_nim.py"))
assert apps_spec is not None
assert apps_spec.loader is not None
apps_nim = importlib.util.module_from_spec(apps_spec)
apps_spec.loader.exec_module(apps_nim)
write_apps_nim = apps_nim.write_apps_nim

js_apps_spec = importlib.util.spec_from_file_location("js_apps", os.path.join(os.path.dirname(__file__), "../backend/app/utils/js_apps.py"))
assert js_apps_spec is not None
assert js_apps_spec.loader is not None
js_apps = importlib.util.module_from_spec(js_apps_spec)
js_apps_spec.loader.exec_module(js_apps)
compile_js_app_dir = js_apps.compile_js_app_dir
is_js_app_dir = js_apps.is_js_app_dir

def main():
    tmp_dir = os.environ.get("FRAMEOS_ROOT_DIR", "frameos")
    source_dir = os.path.abspath(tmp_dir)

    os.makedirs(os.path.join(source_dir, "src", "apps"), exist_ok=True)
    for app_dir in glob(os.path.join(source_dir, "src", "apps", "*", "*")):
        config_path = os.path.join(app_dir, "config.json")
        if os.path.exists(config_path):
            if is_js_app_dir(app_dir):
                compile_js_app_dir(app_dir)
                with open(os.path.join(app_dir, "app.nim"), "w") as af:
                    af.write(write_js_app_nim(app_dir))
            app_loader_nim = write_app_loader_nim(app_dir)
            with open(os.path.join(app_dir, "app_loader.nim"), "w") as lf:
                lf.write(app_loader_nim)

    # write apps.nim
    with open(os.path.join(source_dir, "src", "apps", "apps.nim"), "w") as lf:
        lf.write(write_apps_nim())

if __name__ == "__main__":
    main()
