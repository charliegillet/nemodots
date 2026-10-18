def group_anagrams(words: list[str]) -> list[list[str]]:
    """Group strings that are anagrams (ignoring case and spaces), keeping input order."""
    groups: dict[str, list[str]] = {}
    for word in words:
        key = "".join(sorted(word.lower().replace(" ", "")))
        groups.setdefault(key, []).append(word)
    return list(groups.values())
