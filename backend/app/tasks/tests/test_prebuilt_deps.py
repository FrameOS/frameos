from app.tasks.prebuilt_deps import resolve_prebuilt_target


def test_resolve_prebuilt_target_supports_buildroot_frames():
    assert resolve_prebuilt_target("buildroot", "22.04", "armv7l") == "buildroot-22.04-armhf"
