from app.utils.compiled_plugin_contract import (
    COMPILED_PLUGIN_ABI_VERSION,
    DEFAULT_SNAPSHOT_PATH,
    build_compiled_plugin_contract_snapshot,
    read_compiled_plugin_contract_snapshot,
    read_nim_compiled_plugin_abi_version,
)


def test_compiled_plugin_abi_version_matches_nim_constant() -> None:
    assert COMPILED_PLUGIN_ABI_VERSION == read_nim_compiled_plugin_abi_version()


def test_compiled_plugin_contract_snapshot_is_current() -> None:
    current = build_compiled_plugin_contract_snapshot()
    expected = read_compiled_plugin_contract_snapshot(DEFAULT_SNAPSHOT_PATH)

    if current == expected:
        return

    if current["boundary_hash"] != expected.get("boundary_hash") and current["abi_version"] == expected.get("abi_version"):
        raise AssertionError(
            "Compiled plugin boundary changed without a COMPILED_PLUGIN_ABI_VERSION bump. "
            "If the old compiled .so files are no longer safe to load, bump COMPILED_PLUGIN_ABI_VERSION in "
            "backend/app/utils/compiled_plugin_contract.py and frameos/src/frameos/types.nim, then refresh "
            "the snapshot with `python -m app.utils.compiled_plugin_contract write-snapshot`."
        )

    raise AssertionError(
        "Compiled plugin contract snapshot is stale. "
        "Refresh it with `python -m app.utils.compiled_plugin_contract write-snapshot` after confirming the ABI version is correct."
    )
