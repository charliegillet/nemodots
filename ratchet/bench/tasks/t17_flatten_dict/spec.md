# Flatten a nested dictionary

A metrics exporter needs nested JSON-like config turned into flat `section.key` names. Only
dictionaries are flattened; every other value is copied as-is.

## Function

```python
def flatten(d: dict, sep: str = ".") -> dict
```

## Rules

- Walk `d` recursively. For a value that is a non-empty `dict` (including dict subclasses), descend
  into it; its keys are joined to the parent key with `sep` (`{"a": {"b": 1}}` -> `{"a.b": 1}`).
- Every key is converted with `str()` before joining (`{1: {2: "x"}}` -> `{"1.2": "x"}`); top-level
  keys are converted too.
- Any other value is stored unchanged under its joined key. In particular lists and tuples are **not**
  flattened, even if they contain dicts, and `None`, `0`, `""` and `False` are kept.
- An **empty** nested dict is kept as a value: `{"a": {}}` -> `{"a": {}}`.
- `sep` may be any string, including multi-character ones such as `"__"`.
- Order: keys appear in depth-first order following the insertion order of each dict.
- If two different paths produce the same flat key (e.g. `{"a.b": 1, "a": {"b": 2}}`), raise
  `ValueError`.
- Return a new dict; do not modify `d` or anything inside it. An empty `d` returns `{}`.

## Examples

```python
>>> flatten({"a": {"b": 1, "c": {"d": 2}}, "e": 3})
{'a.b': 1, 'a.c.d': 2, 'e': 3}
>>> flatten({"a": {"b": 1}}, sep="/")
{'a/b': 1}
>>> flatten({"a": [{"b": 1}], "c": {}})
{'a': [{'b': 1}], 'c': {}}
```
