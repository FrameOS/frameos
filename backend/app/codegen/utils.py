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
