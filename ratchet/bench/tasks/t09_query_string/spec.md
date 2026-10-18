# Parse a query string

A tiny web framework needs to turn the query part of a URL into a dictionary that handlers can read.
Repeated parameters must not lose data, and encoded characters must be decoded correctly.

## Function

```python
def parse_query(qs: str) -> dict[str, str | list[str]]
```

## Rules

- A single leading `?` is ignored.
- The string is split on `&` into segments. Empty segments are skipped (`"a=1&&b=2&"` has two pairs).
- Each segment is split on the **first** `=` into key and value; a value may itself contain `=`
  (`"a=b=c"` gives `{"a": "b=c"}`). A segment without `=` is a key with the value `""`.
- Splitting happens **before** decoding, so `%26` and `%3D` inside a value are a literal `&` and `=`.
- Keys and values are then decoded: `+` becomes a space, and percent escapes `%XX` are decoded as
  UTF-8 bytes (`"caf%C3%A9"` is `"café"`; `"%2B"` is a literal `"+"`, not a space). A `%` that is not
  followed by two hex digits is kept literally (`"100%"` stays `"100%"`).
- A key that occurs once maps to its string value. A key that occurs more than once maps to a list of
  all its values in order of appearance.
- Keys appear in the result in order of first appearance. An empty string (or just `"?"`) gives `{}`.

## Examples

```python
>>> parse_query("?a=1&b=hello+world")
{'a': '1', 'b': 'hello world'}
>>> parse_query("tag=x&tag=y&tag=z")
{'tag': ['x', 'y', 'z']}
>>> parse_query("flag&q=caf%C3%A9")
{'flag': '', 'q': 'café'}
>>> parse_query("expr=1%2B1%3D2")
{'expr': '1+1=2'}
```
