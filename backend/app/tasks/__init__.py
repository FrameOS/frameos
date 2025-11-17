"""Task exports with lazy loading."""
from __future__ import annotations

from importlib import import_module
from typing import Any

_TASK_EXPORTS = {
    "build_sd_card_image_task": "build_sd_card_image",
    "fast_deploy_frame": "fast_deploy_frame",
    "deploy_frame": "deploy_frame",
    "reset_frame": "reset_frame",
    "restart_frame": "restart_frame",
    "reboot_frame": "restart_frame",
    "restart_agent": "restart_agent",
    "stop_frame": "stop_frame",
    "deploy_agent": "deploy_agent",
}

__all__ = sorted(_TASK_EXPORTS)


def __getattr__(name: str) -> Any:
    module_name = _TASK_EXPORTS.get(name)
    if not module_name:
        raise AttributeError(f"module 'app.tasks' has no attribute '{name}'")
    module = import_module(f"app.tasks.{module_name}")
    value = getattr(module, name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(__all__)
