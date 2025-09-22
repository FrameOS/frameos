import json
import os
import sys
import requests
import time
from pathlib import Path
from PIL import Image
import imagehash
import subprocess
import signal

def is_similar_image(img_path1, img_content2):
    hash0 = imagehash.dhash(Image.open(img_path1))
    hash1 = imagehash.dhash(Image.open(img_content2))
    cutoff = 5
    return hash0 - hash1 < cutoff

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
            for scene_id in (base_id, base_id + '_interpreted'):
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
                    snapshot_path = snapshots_dir / f"{scene_id}.png"
                    if snapshot_path.exists():
                        temp_path = snapshot_path.with_suffix('.temp.png')
                        with open(temp_path, 'wb') as temp_file:
                            temp_file.write(image_response.content)
                        # if not is_similar_image(snapshot_path, temp_path):
                        with open(snapshot_path, 'wb') as f:
                            f.write(image_response.content)
                        print(f"Snapshot updated: {snapshot_path}")
                        # else:
                            # print(f"Snapshot unchanged due to similarity: {snapshot_path}")
                        temp_path.unlink()
                    else:
                        with open(snapshot_path, 'wb') as f:
                            f.write(image_response.content)
                        print(f"Snapshot saved: {snapshot_path}")
                else:
                    print(f"Failed to get snapshot for scene {scene_id}")
    finally:
        time.sleep(10)
        os.kill(process.pid, signal.SIGTERM)
        print(f"frameos process with PID {process.pid} has been terminated")

if __name__ == "__main__":
    main()
