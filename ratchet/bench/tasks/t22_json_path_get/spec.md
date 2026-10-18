# Get a value by JSON path

A config service lets users read deep values from parsed JSON with paths like `"servers[0].host"`.
Missing data must return a default instead of crashing, but a malformed path is a programming error.

## Function

```python
def get_path(data, path: str, default=None)
```

## Rules

- Path syntax: a sequence of steps. A *key step* is a non-empty name made of any characters except
  `.`, `[` and `]`. An *index step* is `[n]` where `n` is an integer written with ASCII digits and an
  optional leading `-` (negative indexes count from the end, like Python).
- Key steps are separated from the previous step by `.`. The first step has no leading dot.
  Index steps follow directly, without a dot: `a.b[0].c`, `items[-1]`, `m[1][0]`, `[0].name`.
- The empty path `""` returns `data` itself.
- A malformed path raises `ValueError`, regardless of the data. Examples: `"a..b"`, `"a."`, `".a"`,
  `"a[x]"`, `"a["`, `"a[]"`, `"a]"`, `"a[0]b"`, `"a[1.5]"`.
- A key step only applies to a `dict` and looks up the key as a string. An index step only applies to
  a `list` or `tuple`. A digit key step like `a.0` is still a key step (it does not index lists).
- Return `default` when a step cannot be applied: missing key, index out of range, a key step on a
  non-dict, an index step on a non-list/tuple (including strings and dicts), or any step on `None` or
  another scalar.
- If the value found is `None` (present in the data), return `None`, not `default`.

## Examples

```python
>>> data = {"servers": [{"host": "a", "ports": [80, 443]}, {"host": "b"}]}
>>> get_path(data, "servers[0].ports[-1]")
443
>>> get_path(data, "servers[1].ports[0]", default=0)
0
>>> get_path({"a": "xyz"}, "a[0]", default="none")
'none'
>>> get_path(data, "servers..host")
Traceback (most recent call last):
ValueError: ...
```
