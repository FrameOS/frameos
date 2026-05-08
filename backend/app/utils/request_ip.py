from typing import Mapping, Optional


def extract_client_ip(
    headers: Mapping[str, str],
    client_host: Optional[str] = None,
) -> Optional[str]:
    forwarded_for = headers.get("x-forwarded-for")
    if forwarded_for:
        for part in forwarded_for.split(","):
            candidate = part.strip()
            if candidate:
                return candidate

    forwarded = headers.get("forwarded")
    if forwarded:
        for entry in forwarded.split(","):
            for directive in entry.split(";"):
                key, _, value = directive.strip().partition("=")
                if key.lower() == "for" and value:
                    cleaned = value.strip().strip('"')
                    if cleaned.startswith("[") and "]" in cleaned:
                        cleaned = cleaned[1:cleaned.index("]")]
                    if cleaned:
                        return cleaned

    real_ip = headers.get("x-real-ip")
    if real_ip:
        cleaned = real_ip.strip()
        if cleaned:
            return cleaned

    return client_host
