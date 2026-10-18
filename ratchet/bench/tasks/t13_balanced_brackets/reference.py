_CLOSERS = {")": "(", "]": "[", "}": "{"}


def is_balanced(code: str) -> bool:
    """Return True if (), [] and {} are balanced, ignoring brackets inside string literals."""
    stack: list[str] = []
    quote = None
    i = 0
    while i < len(code):
        ch = code[i]
        if quote is not None:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch == '"' or ch == "'":
            quote = ch
        elif ch in "([{":
            stack.append(ch)
        elif ch in _CLOSERS:
            if not stack or stack.pop() != _CLOSERS[ch]:
                return False
        i += 1
    return quote is None and not stack
