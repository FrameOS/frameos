"""Photos share links inside scene JSON (docs/photos.md, "Share links").

A share link is a bearer credential for a whole album, and an album scene
carries one as a plain string in its photoAlbum node's config. The scene AI
never sends one to OpenAI: the model sees a placeholder, and the placeholder
turns back into the link in the scenes it returns.

A link is recognized by the share route's path and its token, whatever is in
front: root-relative as this backend writes them (`/api/photos/shared/pk_...`),
or absolute with the frame's server address or any other host. A bare `pk_...`
is not a link (Stripe publishable keys look the same). Slashes may come
escaped (`\\/` in JSON inside a string, `%2F` in a query parameter).

The cloud has the same module (cloud/apps/auth-web/src/lib/photos/
share-links-in-scenes.ts); keep the two in step."""
from __future__ import annotations

import json
import re
from typing import Any, Callable

_SLASH = r"(?:\\*/|%2[Ff])"
_TOKEN_CHARS = "A-Za-z0-9_-"
_LINK_RE = re.compile(
    rf"{_SLASH}api{_SLASH}photos{_SLASH}shared{_SLASH}(pk_[{_TOKEN_CHARS}]{{32,128}})(?![{_TOKEN_CHARS}])"
)
# Not inside a longer word, except right after an escaped slash (`%2F`).
_WORD_START = rf"(?:(?<=%2[Ff])|(?<![{_TOKEN_CHARS}]))"
# What the model sees instead of a token: `pk_photo_link_1`, ... - short
# enough that it is never mistaken for a token itself.
PLACEHOLDER_PREFIX = "pk_photo_link_"
_PLACEHOLDER_RE = re.compile(rf"{_WORD_START}{PLACEHOLDER_PREFIX}(\d{{1,6}})(?![{_TOKEN_CHARS}])")
_TOKEN_RE = re.compile(rf"{_WORD_START}pk_[{_TOKEN_CHARS}]{{32,128}}(?![{_TOKEN_CHARS}])")


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return ""


def has_photo_share_link(value: Any) -> bool:
    """True when any string in `value` (keys included, at any depth) holds a
    Photos share link."""
    if value is None:
        return False
    text = _as_text(value)
    return "pk_" in text and _LINK_RE.search(text) is not None


def _map_strings(value: Any, transform: Callable[[str], str]) -> Any:
    if isinstance(value, str):
        return transform(value)
    if isinstance(value, list):
        return [_map_strings(item, transform) for item in value]
    if isinstance(value, dict):
        return {
            (transform(key) if isinstance(key, str) else key): _map_strings(item, transform)
            for key, item in value.items()
        }
    return value


class PhotoLinkRedactor:
    """One chat request's swap of share tokens for placeholders. Each distinct
    token gets the next number the first time it is seen and keeps it, so the
    same link reads the same everywhere the model meets it. Only the token is
    swapped: the host and the path stay, so the model still sees an album
    link."""

    def __init__(self) -> None:
        self._numbers: dict[str, int] = {}
        self._tokens: list[str] = []

    @property
    def size(self) -> int:
        return len(self._tokens)

    def redact_text(self, text: str) -> str:
        if "pk_" not in text:
            return text
        for match in _LINK_RE.finditer(text):
            token = match.group(1)
            if token not in self._numbers:
                self._tokens.append(token)
                self._numbers[token] = len(self._tokens)
        if not self._tokens:
            return text

        # Every known token goes, also where it appears without the path.
        def replace(match: re.Match[str]) -> str:
            number = self._numbers.get(match.group(0))
            return match.group(0) if number is None else f"{PLACEHOLDER_PREFIX}{number}"

        return _TOKEN_RE.sub(replace, text)

    def restore_text(self, text: str) -> str:
        if not self._tokens or PLACEHOLDER_PREFIX not in text:
            return text

        def replace(match: re.Match[str]) -> str:
            index = int(match.group(1)) - 1
            return self._tokens[index] if 0 <= index < len(self._tokens) else match.group(0)

        return _PLACEHOLDER_RE.sub(replace, text)

    def redact(self, value: Any) -> Any:
        """A copy of `value` (JSON-like: dicts, lists, strings) with every
        string and key redacted."""
        return _map_strings(value, self.redact_text)

    def restore(self, value: Any) -> Any:
        return _map_strings(value, self.restore_text)
