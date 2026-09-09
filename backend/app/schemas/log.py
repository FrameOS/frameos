from typing import Any, List, Optional

from pydantic import BaseModel, field_validator


def _validate_log_entry(entry: Any) -> Any:
    """One log line as the runtime posts it: an object, or `[timestamp,
    object]` (the batched form with the line's own time). Anything else is
    rejected here, before the route commits a row for it — a bare `assert`
    used to do this after the insert, and `-O` strips asserts entirely."""
    if isinstance(entry, dict):
        return entry
    if (
        isinstance(entry, list)
        and len(entry) == 2
        and isinstance(entry[0], (int, float))
        and not isinstance(entry[0], bool)
        and isinstance(entry[1], dict)
    ):
        return entry
    raise ValueError("a log entry must be an object or a [timestamp, object] pair")


class SingleLogEntry(BaseModel):
    event: Optional[str] = None
    # add other fields as needed
    # __root__: Dict[str, Any]

class LogRequest(BaseModel):
    log: Optional[Any] = None
    logs: Optional[List[Any]] = None

    @field_validator("log")
    @classmethod
    def _check_log(cls, value: Any) -> Any:
        return None if value is None else _validate_log_entry(value)

    @field_validator("logs")
    @classmethod
    def _check_logs(cls, value: Optional[List[Any]]) -> Optional[List[Any]]:
        if value is None:
            return None
        return [_validate_log_entry(entry) for entry in value]

class LogResponse(BaseModel):
    message: str = "OK"
