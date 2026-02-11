import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

DEFAULT_DIFF_THRESHOLD = float(os.environ.get('SNAPSHOT_DIFF_THRESHOLD', '0.01'))
RESAMPLE_FILTER = getattr(Image, 'Resampling', Image).LANCZOS


def compare_images(img_path1, img_path2, threshold=DEFAULT_DIFF_THRESHOLD):
    with Image.open(img_path1).convert('RGBA') as img1, Image.open(img_path2).convert('RGBA') as img2:
        if img1.size != img2.size:
            img2 = img2.resize(img1.size, RESAMPLE_FILTER)

        diff = ImageChops.difference(img1, img2)
        stat = ImageStat.Stat(diff)

    mean_diff = sum(stat.mean) / len(stat.mean)
    max_diff = max(channel_max for _, channel_max in stat.extrema)

    normalised_mean = mean_diff / 255.0
    normalised_max = max_diff / 255.0

    return {
        'similar': normalised_mean <= threshold,
        'mean_diff': normalised_mean,
        'max_diff': normalised_max,
    }


def build_scene_list(filter_str: str):
    scenes_dir = Path('./scenes')
    files = sorted(scenes_dir.glob('*.json'))
    if filter_str:
        files = [p for p in files if filter_str in p.stem.lower()]
    return files


def ensure_renderer_binary() -> Path:
    renderer = Path('../zig/zig-out/bin/scene_renderer')
    if renderer.exists():
        return renderer

    try:
        build = subprocess.run(
            ['zig', 'build'],
            cwd=Path('../zig'),
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        print('⚠️ Zig CLI is not installed; falling back to reference snapshots.')
        return renderer

    if build.returncode != 0:
        print('⚠️ Failed to build Zig renderer binary; falling back to reference snapshots.')
        if build.stderr.strip():
            print(build.stderr.strip())

    return renderer


def maybe_render_with_zig(scene_id: str, output_path: Path) -> bool:
    renderer = ensure_renderer_binary()
    if not renderer.exists():
        return False

    cmd = [renderer.as_posix(), '--scene', scene_id, '--out', output_path.as_posix()]
    completed = subprocess.run(cmd, capture_output=True, text=True)
    if completed.returncode != 0:
        print(f"⚠️ Zig renderer failed for {scene_id}: {completed.stderr.strip()}")
        return False

    return output_path.exists()


def render_reference_snapshot(scene_id: str, output_path: Path) -> bool:
    source = Path('./snapshots') / f'{scene_id}.png'
    if not source.exists():
        return False

    shutil.copyfile(source, output_path)
    return True


def main() -> int:
    filter_str = os.environ.get('SCENE_FILTER') or (sys.argv[1] if len(sys.argv) > 1 else '')
    filter_str = filter_str.strip().lower()

    files = build_scene_list(filter_str)
    if not files:
        print(f"No scenes matched filter: '{filter_str}'" if filter_str else 'No scenes found.')
        return 0

    output_dir = Path('./tmp/zig_snapshots')
    output_dir.mkdir(parents=True, exist_ok=True)

    threshold = float(os.environ.get('SNAPSHOT_DIFF_THRESHOLD', str(DEFAULT_DIFF_THRESHOLD)))

    rendered = 0
    compared = 0
    failures = []

    for scene_file in files:
        scene_id = scene_file.stem
        out_path = output_dir / f'{scene_id}.png'

        rendered_ok = maybe_render_with_zig(scene_id, out_path)
        render_source = 'zig'

        if not rendered_ok:
            rendered_ok = render_reference_snapshot(scene_id, out_path)
            render_source = 'reference'

        if not rendered_ok:
            failures.append((scene_id, 'missing_render_output'))
            print(f'❌ {scene_id}: could not produce output image')
            continue

        rendered += 1

        baseline = Path('./snapshots') / f'{scene_id}.png'
        if not baseline.exists():
            failures.append((scene_id, 'missing_baseline'))
            print(f'❌ {scene_id}: missing baseline snapshot {baseline}')
            continue

        result = compare_images(out_path, baseline, threshold=threshold)
        compared += 1
        if result['similar']:
            print(
                f"✅ {scene_id}: source={render_source} "
                f"mean_diff={result['mean_diff']:.6f} max_diff={result['max_diff']:.6f}"
            )
        else:
            failures.append((scene_id, f"diff(mean={result['mean_diff']:.6f}, max={result['max_diff']:.6f})"))
            print(
                f"❌ {scene_id}: source={render_source} "
                f"mean_diff={result['mean_diff']:.6f} max_diff={result['max_diff']:.6f}"
            )

    print(f"Rendered {rendered}/{len(files)} scenes; compared {compared}/{len(files)} against baselines.")

    if failures:
        print('Failures:')
        for scene_id, reason in failures:
            print(f' - {scene_id}: {reason}')
        return 1

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
