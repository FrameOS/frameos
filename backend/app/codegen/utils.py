import re

def sanitize_nim_string(string: str) -> str:
    # Escape backslash FIRST, otherwise a trailing/literal backslash escapes the
    # template's closing quote (e.g. a value ending in '\' produces an
    # unterminated Nim string literal -> compile-time DoS on deploy). Also escape
    # carriage returns so CRLF in user input can't break out of the literal.
    return (
        string.replace('\\', '\\\\')
        .replace('"', '\\"')
        .replace('\r', '\\r')
        .replace('\n', '\\n')
    )

def select_field_options(options) -> list[tuple[str, str]]:
    """(value, label) pairs for a select field.

    Options are stored as plain strings, or as {"value": .., "label": ..} pairs when the
    label shown differs from the stored value. Anything unusable is dropped rather than
    written into the scene as garbage.
    """
    pairs: list[tuple[str, str]] = []
    for option in options or []:
        if isinstance(option, dict):
            value = option.get("value")
            label = option.get("label")
        else:
            value = option
            label = None
        if isinstance(value, bool) or value is None or isinstance(value, (dict, list)):
            continue
        value = str(value)
        if isinstance(label, bool) or label is None or isinstance(label, (dict, list)):
            label = value
        pairs.append((value, str(label)))
    return pairs


def nim_comment(text) -> str:
    # Collapse user text to a single line for use in a generated Nim comment: a
    # raw newline would otherwise close the '# ...' comment and let the rest of
    # the value inject code into the generated source.
    if text is None:
        return ""
    return str(text).replace("\r", " ").replace("\n", " ")

def atoi(text):
    return int(text) if text.isdigit() else text

def natural_keys(text):
    return [ atoi(c) for c in re.split(r'(\d+)', text) ]
