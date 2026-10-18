def _indent(line: str) -> str:
    return line[: len(line) - len(line.lstrip(" \t"))]


def dedent(text: str) -> str:
    """Remove the common leading whitespace from every non-blank line of `text`."""
    if text.startswith("\n"):
        text = text[1:]
    lines = text.split("\n")
    margin = None
    for line in lines:
        if not line.strip(" \t"):
            continue
        indent = _indent(line)
        if margin is None:
            margin = indent
            continue
        i = 0
        while i < len(margin) and i < len(indent) and margin[i] == indent[i]:
            i += 1
        margin = margin[:i]
    cut = len(margin or "")
    return "\n".join("" if not line.strip(" \t") else line[cut:] for line in lines)
