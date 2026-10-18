_DIGITS = "0123456789"


def encode(s: str) -> str:
    """Run-length encode `s` (digits and backslashes are escaped)."""
    out: list[str] = []
    i = 0
    while i < len(s):
        ch = s[i]
        j = i
        while j < len(s) and s[j] == ch:
            j += 1
        out.append(str(j - i))
        out.append("\\" + ch if ch in _DIGITS or ch == "\\" else ch)
        i = j
    return "".join(out)


def decode(s: str) -> str:
    """Decode the output of `encode`; raise ValueError on malformed input."""
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        j = i
        while j < n and s[j] in _DIGITS:
            j += 1
        if j == i:
            raise ValueError(f"missing count at position {i}")
        count = int(s[i:j])
        if count == 0:
            raise ValueError(f"zero count at position {i}")
        if j >= n:
            raise ValueError("count without a character at the end")
        if s[j] == "\\":
            if j + 1 >= n:
                raise ValueError("dangling backslash at the end")
            ch = s[j + 1]
            i = j + 2
        else:
            ch = s[j]
            i = j + 1
        out.append(ch * count)
    return "".join(out)
