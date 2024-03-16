import requests
import time
from pathlib import Path
from PIL import Image
import imagehash


def is_similar_image(img_path1, img_content2):
    """Check if two images are visually similar."""
    hash0 = imagehash.average_hash(Image.open(img_path1))
    hash1 = imagehash.average_hash(Image.open(img_content2))
    cutoff = 5
    return hash0 - hash1 < cutoff


def main():
    scenes_dir = Path('./scenes')  # Directory containing scene JSON files
    snapshots_dir = Path('./snapshots')  # Directory where snapshots will be saved
    snapshots_dir.mkdir(exist_ok=True)  # Ensure the snapshots directory exists

    for scene_file in scenes_dir.glob('*.json'):
        scene_id = scene_file.stem
        print(f"Processing scene: {scene_id}")

        # Post request to switch to the current scene
        response = requests.post('http://localhost:8787/event/setCurrentScene', json={'sceneId': scene_id})
        if response.status_code != 200:
            print(f"Failed to set scene {scene_id}")
            continue  # Skip this scene if the request failed

        time.sleep(1)  # Wait for the scene to fully load

        # Get the current scene as an image
        image_response = requests.get('http://localhost:8787/image')
        if image_response.status_code == 200:
            snapshot_path = snapshots_dir / f"{scene_id}.png"
            if snapshot_path.exists():
                # Temporarily save the new image to compare
                temp_path = snapshot_path.with_suffix('.temp.png')
                with open(temp_path, 'wb') as temp_file:
                    temp_file.write(image_response.content)

                # Only overwrite the image if it's not visually similar
                if not is_similar_image(snapshot_path, temp_path):
                    with open(snapshot_path, 'wb') as f:
                        f.write(image_response.content)
                    print(f"Snapshot updated: {snapshot_path}")
                else:
                    print(f"Snapshot unchanged due to similarity: {snapshot_path}")

                # Clean up the temporary file
                temp_path.unlink()
            else:
                with open(snapshot_path, 'wb') as f:
                    f.write(image_response.content)
                print(f"Snapshot saved: {snapshot_path}")
        else:
            print(f"Failed to get snapshot for scene {scene_id}")


if __name__ == "__main__":
    main()
