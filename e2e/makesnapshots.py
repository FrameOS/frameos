import json
import os
import sys
import requests
import time
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import subprocess
import signal

DEFAULT_DIFF_THRESHOLD = float(os.environ.get("SNAPSHOT_DIFF_THRESHOLD", "0.01"))
RESAMPLE_FILTER = getattr(Image, "Resampling", Image).LANCZOS

def compare_images(img_path1, img_path2, threshold=DEFAULT_DIFF_THRESHOLD):
    """Return similarity information between two images.

    The function computes the mean absolute pixel difference normalised to the
    range [0, 1] and considers the images similar when the mean is less than or
    equal to ``threshold``. The maximum pixel delta is reported for additional
    insight.
    """

    with Image.open(img_path1).convert("RGBA") as img1, Image.open(img_path2).convert("RGBA") as img2:
        if img1.size != img2.size:
            img2 = img2.resize(img1.size, RESAMPLE_FILTER)

        diff = ImageChops.difference(img1, img2)
        stat = ImageStat.Stat(diff)

    mean_diff = sum(stat.mean) / len(stat.mean)
    max_diff = max(channel_max for _, channel_max in stat.extrema)

    normalised_mean = mean_diff / 255.0
    normalised_max = max_diff / 255.0

    return {
        "similar": normalised_mean <= threshold,
        "mean_diff": normalised_mean,
        "max_diff": normalised_max,
    }

def is_similar_image(img_path1, img_path2, threshold=DEFAULT_DIFF_THRESHOLD):
    result = compare_images(img_path1, img_path2, threshold)
    return result["similar"]

def main():
    # filter from env or argv (argv optional)
    filter_str = os.environ.get("SCENE_FILTER") or (sys.argv[1] if len(sys.argv) > 1 else "")
    filter_str = filter_str.strip().lower()
    os.environ["FRAMEOS_SCENES_JSON"] = Path('./tmp/scenes.json').resolve().as_posix()
    # Start the frameos binary in the background
    process = subprocess.Popen(['./tmp/frameos', '--debug'])
    print(f"Started frameos with PID {process.pid}")
    time.sleep(2)

    frame_json = Path('./frame.json')
    contents = json.loads(frame_json.read_text())
    port = contents.get('framePort', 8787)

    scenes_dir = Path('./scenes')
    snapshots_dir = Path('./snapshots')
    snapshots_dir.mkdir(exist_ok=True)

    try:
        files = sorted(scenes_dir.glob('*.json'))
        if filter_str:
            files = [p for p in files if filter_str in p.stem.lower()]

        if not files:
            print(f"No scenes matched filter: '{filter_str}'" if filter_str else "No scenes found.")
            return

        for scene_file in files:
            base_id = scene_file.stem
            for (scene_id, filename) in [
                (base_id, base_id + '_compiled'), 
                (base_id + '_interpreted', base_id + '_interpreted')
            ]:
                print(f"🍿 Processing scene: {scene_id}")

                r = requests.post(f'http://localhost:{port}/event/setCurrentScene', json={'sceneId': 'black'})
                if r.status_code != 200:
                    print(f"Failed to set scene {scene_id} to black")
                    continue
                time.sleep(0.5)

                r = requests.post(f'http://localhost:{port}/event/setCurrentScene', json={'sceneId': scene_id})
                if r.status_code != 200:
                    print(f"Failed to set scene {scene_id}")
                    continue
                time.sleep(1)

                image_response = requests.get(f'http://localhost:{port}/image')
                if image_response.status_code == 200:
                    snapshot_path = snapshots_dir / f"{filename}.png"
                    with open(snapshot_path, 'wb') as f:
                        f.write(image_response.content)
                    print(f"Snapshot captured: {snapshot_path}")
                else:
                    print(f"Failed to get snapshot for scene {scene_id}")
            # compare files: base_id + '_compiled' and base_id + '_interpreted'
            compiled_path = snapshots_dir / f"{base_id}_compiled.png"
            interpreted_path = snapshots_dir / f"{base_id}_interpreted.png"
            if compiled_path.exists() and interpreted_path.exists():
                if is_similar_image(compiled_path, interpreted_path):
                    print(f"✅ Snapshots are similar for scene {base_id}")
                    # rename to base_id.png
                    final_path = snapshots_dir / f"{base_id}.png"
                    interpreted_path.unlink()
                    if final_path.exists():
                        if is_similar_image(final_path, compiled_path):
                            compiled_path.unlink()
                        else:
                            final_path.unlink()
                            compiled_path.rename(final_path)
                    else:
                        compiled_path.rename(final_path)
                else:
                    print(f"❌ Snapshots differ for scene {base_id}")
                    final_path = snapshots_dir / f"{base_id}.png"
                    final_path.unlink(missing_ok=True)
    finally:
        time.sleep(2)
        os.kill(process.pid, signal.SIGTERM)
        print(f"frameos process with PID {process.pid} has been terminated")

if __name__ == "__main__":
    main()
