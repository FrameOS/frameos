import io
import tarfile
from collections.abc import Callable
from pathlib import Path

import pytest

from app.utils import prebuilt_component
from app.utils.cross_compile import CrossCompiler


def _write_tarball(member_name: str, *, member_type: bytes = tarfile.REGTYPE, linkname: str = "") -> io.BytesIO:
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as tar:
        info = tarfile.TarInfo(name=member_name)
        info.type = member_type
        if member_type == tarfile.REGTYPE:
            payload = b"payload"
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
        else:
            info.linkname = linkname
            tar.addfile(info)
    archive.seek(0)
    return archive


@pytest.mark.parametrize(
    "extractor",
    [
        pytest.param(CrossCompiler._safe_extract, id="cross_compile"),
        pytest.param(prebuilt_component._safe_extract, id="prebuilt_component"),
    ],
)
def test_safe_extract_rejects_prefix_escape(
    tmp_path: Path,
    extractor: Callable[[tarfile.TarFile, Path], None],
) -> None:
    dest_dir = tmp_path / "cache"
    escaped_dir = tmp_path / "cache-escape"
    dest_dir.mkdir()

    archive = _write_tarball("../cache-escape/evil.txt")
    with tarfile.open(fileobj=archive, mode="r:gz") as tar:
        with pytest.raises(RuntimeError, match="escape target directory"):
            extractor(tar, dest_dir)

    assert not (escaped_dir / "evil.txt").exists()


@pytest.mark.parametrize(
    "extractor",
    [
        pytest.param(CrossCompiler._safe_extract, id="cross_compile"),
        pytest.param(prebuilt_component._safe_extract, id="prebuilt_component"),
    ],
)
def test_safe_extract_rejects_symlink_entries(
    tmp_path: Path,
    extractor: Callable[[tarfile.TarFile, Path], None],
) -> None:
    dest_dir = tmp_path / "cache"
    dest_dir.mkdir()

    archive = _write_tarball("drivers/link", member_type=tarfile.SYMTYPE, linkname="../escape")
    with tarfile.open(fileobj=archive, mode="r:gz") as tar:
        with pytest.raises(RuntimeError, match="unsupported special entry"):
            extractor(tar, dest_dir)
