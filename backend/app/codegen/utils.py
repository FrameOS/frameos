
def sanitize_nim_string(string: str) -> str:
    return string.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')
