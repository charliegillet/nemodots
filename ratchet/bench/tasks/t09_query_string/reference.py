from urllib.parse import unquote_plus


def parse_query(qs: str) -> dict[str, str | list[str]]:
    """Parse a URL query string into a dict (repeated keys become lists)."""
    if qs.startswith("?"):
        qs = qs[1:]
    result: dict[str, str | list[str]] = {}
    for segment in qs.split("&"):
        if not segment:
            continue
        raw_key, _, raw_value = segment.partition("=")
        key = unquote_plus(raw_key)
        value = unquote_plus(raw_value)
        if key not in result:
            result[key] = value
        elif isinstance(result[key], list):
            result[key].append(value)
        else:
            result[key] = [result[key], value]
    return result
