def wrap(text: str, width: int) -> list[str]:
    """Greedily wrap `text` to lines of at most `width` characters."""
    if width < 1:
        raise ValueError("width must be at least 1")
    out: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            out.append("")
            continue
        line = ""
        for word in words:
            if len(word) > width:
                if line:
                    out.append(line)
                    line = ""
                while len(word) > width:
                    out.append(word[:width])
                    word = word[width:]
            if not line:
                line = word
            elif len(line) + 1 + len(word) <= width:
                line += " " + word
            else:
                out.append(line)
                line = word
        out.append(line)
    return out
