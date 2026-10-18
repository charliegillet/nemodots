import re

_CORE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
_IDENT = re.compile(r"[0-9A-Za-z-]+")
_NUMERIC = re.compile(r"[0-9]+")


def _parse(version: str) -> tuple[tuple[int, int, int], list[str]]:
    text = version[1:] if version[:1] in ("v", "V") else version
    text, plus, build = text.partition("+")
    if plus and not all(_IDENT.fullmatch(part) for part in build.split(".")):
        raise ValueError(f"invalid build metadata in {version!r}")
    core, dash, pre = text.partition("-")
    m = _CORE.fullmatch(core)
    if m is None:
        raise ValueError(f"invalid version core in {version!r}")
    identifiers: list[str] = []
    if dash:
        identifiers = pre.split(".")
        for ident in identifiers:
            if not _IDENT.fullmatch(ident):
                raise ValueError(f"invalid prerelease identifier {ident!r} in {version!r}")
            if _NUMERIC.fullmatch(ident) and len(ident) > 1 and ident[0] == "0":
                raise ValueError(f"numeric identifier with leading zero in {version!r}")
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))), identifiers


def _cmp(x, y) -> int:
    return (x > y) - (x < y)


def compare_versions(a: str, b: str) -> int:
    """Compare two semantic versions; return -1, 0 or 1."""
    core_a, pre_a = _parse(a)
    core_b, pre_b = _parse(b)
    if core_a != core_b:
        return _cmp(core_a, core_b)
    if pre_a == pre_b:
        return 0
    if not pre_a:
        return 1
    if not pre_b:
        return -1
    for x, y in zip(pre_a, pre_b):
        if x == y:
            continue
        x_num = _NUMERIC.fullmatch(x) is not None
        y_num = _NUMERIC.fullmatch(y) is not None
        if x_num and y_num:
            return _cmp(int(x), int(y))
        if x_num:
            return -1
        if y_num:
            return 1
        return _cmp(x, y)
    return _cmp(len(pre_a), len(pre_b))
