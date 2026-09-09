"""Both release-archive extractors refuse members that would land outside the
destination: a ``../`` name (caught by the name check) and a symlink whose
target points outside (only the ``filter="data"`` extraction can see that —
the name check alone let it through, and a following member could then
write through the link)."""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from app.tasks.precompiled_frameos import _safe_extract as precompiled_safe_extract
from app.utils.cross_compile import CrossCompiler

EXTRACTORS = [
    pytest.param(precompiled_safe_extract, id="precompiled_release"),
    pytest.param(CrossCompiler._safe_extract, id="cross_compiler_component"),
]


def _tar_with(members: list[tuple[str, bytes | None, str | None]]) -> tarfile.TarFile:
    """An in-memory tar: ``(name, content, symlink_target)`` per member."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, content, link_target in members:
            info = tarfile.TarInfo(name)
            if link_target is not None:
                info.type = tarfile.SYMTYPE
                info.linkname = link_target
                tar.addfile(info)
            else:
                data = content or b""
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    buffer.seek(0)
    return tarfile.open(fileobj=buffer, mode="r:gz")


@pytest.mark.parametrize("extract", EXTRACTORS)
def test_plain_members_extract(tmp_path: Path, extract):
    dest = tmp_path / "dest"
    dest.mkdir()
    with _tar_with([("frameos/frameos", b"binary", None), ("frameos/drivers/x.so", b"so", None)]) as tar:
        extract(tar, dest)
    assert (dest / "frameos" / "frameos").read_bytes() == b"binary"
    assert (dest / "frameos" / "drivers" / "x.so").read_bytes() == b"so"


@pytest.mark.parametrize("extract", EXTRACTORS)
def test_parent_directory_member_is_refused_before_anything_is_written(tmp_path: Path, extract):
    dest = tmp_path / "dest"
    dest.mkdir()
    with _tar_with([("ok.txt", b"ok", None), ("../escape.txt", b"pwned", None)]) as tar:
        with pytest.raises(RuntimeError, match="escape"):
            extract(tar, dest)
    assert not (tmp_path / "escape.txt").exists()
    assert not (dest / "ok.txt").exists(), "the name check runs over the whole archive first"


@pytest.mark.parametrize("extract", EXTRACTORS)
def test_symlink_member_pointing_outside_is_refused(tmp_path: Path, extract):
    dest = tmp_path / "dest"
    dest.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("keep me")
    with _tar_with([("link", None, "../outside.txt"), ("link/overwrite.txt", b"pwned", None)]) as tar:
        with pytest.raises(RuntimeError, match="escape"):
            extract(tar, dest)
    assert not (dest / "link").is_symlink()
    assert not (dest / "link").exists()
    assert outside.read_text() == "keep me"


@pytest.mark.parametrize("extract", EXTRACTORS)
def test_sibling_directory_sharing_the_prefix_is_still_outside(tmp_path: Path, extract):
    # ``dest-evil`` starts with ``dest``: a prefix comparison without the
    # separator accepted it.
    dest = tmp_path / "dest"
    dest.mkdir()
    with _tar_with([("../dest-evil/x.txt", b"pwned", None)]) as tar:
        with pytest.raises(RuntimeError, match="escape"):
            extract(tar, dest)
    assert not (tmp_path / "dest-evil").exists()
