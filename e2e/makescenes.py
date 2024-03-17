import sys
import json
from pathlib import Path

# sys.path.append(str(Path(__file__).resolve().parents[2]))

from app.codegen.scene_nim import write_scene_nim, write_scenes_nim
from app.models import Frame

if __name__ == '__main__':
    scenes_dir = Path('./scenes')
    generated_dir = Path('./generated')
    scenes = {}

    generated_dir.mkdir(exist_ok=True)

    for file_path in scenes_dir.glob('*.json'):
        with open(file_path, 'r') as file:
            scene = json.load(file)
            scene['id'] = file_path.stem
            scene['default'] = False
            scenes[file_path.stem] = scene
    
    scene_list = list(scenes.values())
    scene_list.sort(key=lambda x: x['id'])
    scene_list[0]['default'] = True

    frame = Frame(
        name="Test frame",
        scenes=scene_list
    )

    for scene_name, scene_data in scenes.items():
        scene_nim = write_scene_nim(frame, scene_data)
        scene_file_path = generated_dir / f'scene_{scene_name}.nim'
        with open(scene_file_path, 'w') as scene_file:
            scene_file.write("# This file is autogenerated\n" + scene_nim)
    
    scenes_nim = write_scenes_nim(frame)
    scenes_nim_file_path = generated_dir / 'scenes.nim'
    with open(scenes_nim_file_path, 'w') as scenes_file:
        scenes_file.write("# This file is autogenerated\n" + scenes_nim)

    print("All scenes have been processed and saved.")
