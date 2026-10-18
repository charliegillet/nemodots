def flatten(d: dict, sep: str = ".") -> dict:
    """Flatten nested dicts into a single dict with `sep`-joined keys."""
    out: dict = {}

    def walk(obj: dict, prefix: str | None) -> None:
        for key, value in obj.items():
            flat_key = str(key) if prefix is None else prefix + sep + str(key)
            if isinstance(value, dict) and value:
                walk(value, flat_key)
                continue
            if flat_key in out:
                raise ValueError(f"duplicate flattened key {flat_key!r}")
            out[flat_key] = {} if isinstance(value, dict) else value

    walk(d, None)
    return out
