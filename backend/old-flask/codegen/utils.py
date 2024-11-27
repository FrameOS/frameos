import re

def sanitize_nim_string(string: str) -> str:
    return string.replace('"', '\\"').replace('\n', '\\n')

def atoi(text):
    return int(text) if text.isdigit() else text

def natural_keys(text):
    return [ atoi(c) for c in re.split(r'(\d+)', text) ]
