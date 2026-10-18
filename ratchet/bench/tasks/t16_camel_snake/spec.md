# camelCase and snake_case

A code generator converts identifiers between a JSON API (camelCase) and Python (snake_case). The
conversions must handle acronyms and digits the way humans expect.

## Functions

```python
def to_snake(name: str) -> str
def to_camel(name: str, upper_first: bool = False) -> str
```

## Rules

`to_snake(name)`:

- Insert `_` between a lowercase letter or a digit and a following uppercase letter
  (`fooBar` -> `foo_bar`, `v2Beta` -> `v2_beta`).
- Insert `_` inside a run of uppercase letters before its last letter when that letter is followed by
  a lowercase letter: the run is an acronym followed by a word (`HTTPServer` -> `http_server`,
  `getHTTPResponseCode` -> `get_http_response_code`).
- Never insert `_` between a letter and a following digit (`utf8Decode` -> `utf8_decode`,
  `base64` -> `base64`).
- Then lowercase the whole result. An all-uppercase name is one word (`ABC` -> `abc`).
- Existing underscores are kept as they are and never doubled (`foo_Bar` -> `foo_bar`); a name that is
  already snake_case is returned unchanged. `""` returns `""`.
- Only ASCII letters are considered upper/lowercase for boundary detection.

`to_camel(name, upper_first=False)`:

- Split `name` on `_` and ignore empty parts (so leading, trailing and repeated underscores vanish).
- The first part is lowercased entirely; with `upper_first=True` it gets an uppercase first character
  and the rest lowercased instead.
- Every following part gets an uppercase first character and the rest lowercased
  (`HTTP_SERVER` -> `httpServer`).
- Digits are kept as they are (`v2_beta` -> `v2Beta`). If there are no non-empty parts, return `""`.

## Examples

```python
>>> to_snake("HTTPServer")
'http_server'
>>> to_snake("v2Beta")
'v2_beta'
>>> to_snake("already_snake")
'already_snake'
>>> to_camel("http_server")
'httpServer'
>>> to_camel("__foo__bar_", upper_first=True)
'FooBar'
```
