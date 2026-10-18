import re
import unicodedata

_WORD = re.compile(r"[a-z0-9]+")


def slugify(text: str, max_length: int | None = None, separator: str = "-") -> str:
    """Return an ASCII, lowercase URL slug for `text`."""
    if max_length is not None and max_length < 1:
        raise ValueError("max_length must be at least 1")
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    words = _WORD.findall(ascii_text.lower())
    if max_length is None:
        return separator.join(words)
    kept: list[str] = []
    length = 0
    for word in words:
        extra = len(word) if not kept else len(separator) + len(word)
        if length + extra > max_length:
            break
        kept.append(word)
        length += extra
    if not kept and words:
        return words[0][:max_length]
    return separator.join(kept)
