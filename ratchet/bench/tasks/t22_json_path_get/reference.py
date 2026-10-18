import re

_KEY = re.compile(r"[^.\[\]]+")
_INDEX = re.compile(r"-?[0-9]+")


def _parse(path: str) -> list:
    steps: list = []
    i = 0
    n = len(path)
    while i < n:
        if path[i] == "[":
            j = path.find("]", i)
            if j == -1 or not _INDEX.fullmatch(path[i + 1:j]):
                raise ValueError(f"malformed index in path {path!r}")
            steps.append(int(path[i + 1:j]))
            i = j + 1
            continue
        if steps:
            if path[i] != ".":
                raise ValueError(f"expected '.' at position {i} in path {path!r}")
            i += 1
        m = _KEY.match(path, i)
        if m is None:
            raise ValueError(f"expected a key at position {i} in path {path!r}")
        steps.append(m.group())
        i = m.end()
    return steps


def get_path(data, path: str, default=None):
    """Return the value at `path` (e.g. 'a.b[0].c') in nested dicts/lists, or `default`."""
    current = data
    for step in _parse(path):
        if isinstance(step, int):
            if not isinstance(current, (list, tuple)):
                return default
            try:
                current = current[step]
            except IndexError:
                return default
        else:
            if not isinstance(current, dict) or step not in current:
                return default
            current = current[step]
    return current
