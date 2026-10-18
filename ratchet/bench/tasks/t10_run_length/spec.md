# Run-length encoding

A log shipper compresses highly repetitive lines with run-length encoding. The encoding must be
lossless for **any** string, including strings that contain digits and backslashes.

## Functions

```python
def encode(s: str) -> str
def decode(s: str) -> str
```

## Rules

- `encode` replaces every maximal run of the same character with `<count><char>`, where `<count>` is
  the run length in decimal, written even when it is 1 (`"aab"` gives `"2a1b"`). Runs are
  case-sensitive and any character (spaces, newlines, non-ASCII) can be run-length encoded.
- Escaping: if the character is an ASCII digit (`0`-`9`) or a backslash (`\`), it is written as a
  backslash followed by the character. So `"111"` encodes to `3\1` and a single `\` encodes to `1\\`.
- `decode` is the exact inverse: `decode(encode(s)) == s` for every string `s`.
- `decode` reads repeated groups of: one or more ASCII digits (the count, which must be at least 1),
  then either a backslash followed by exactly one character (taken literally), or one character that
  is neither a digit nor a backslash.
- `decode` raises `ValueError` on malformed input: a group without a count (`"a"`), a count without a
  character (`"3"`), a zero count (`"0a"`), or a backslash with nothing after it (`"2\"`).
- The empty string encodes and decodes to the empty string.

## Examples

```python
>>> encode("aaabccdddd")
'3a1b2c4d'
>>> encode("a" * 12)
'12a'
>>> print(encode("111223"))
3\12\21\3
>>> decode("12a1b")
'aaaaaaaaaaaab'
>>> decode(r"3\1")
'111'
```
