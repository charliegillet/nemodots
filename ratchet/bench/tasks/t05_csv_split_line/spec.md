# Split one CSV line

An import tool reads exported spreadsheet rows one line at a time. Split a single CSV line into its
fields, following the usual double-quote conventions, without using the `csv` module's dialect guessing.

## Function

```python
def split_csv_line(line: str, delimiter: str = ",") -> list[str]
```

## Rules

- `delimiter` must be exactly one character and must not be `"`; otherwise raise `ValueError`.
- Fields are separated by `delimiter`. A line with `k` delimiters (outside quotes) has `k + 1` fields,
  so an empty line gives `[""]`, `"a,"` gives `["a", ""]` and `"a,,b"` gives `["a", "", "b"]`.
- Whitespace is part of the field and is never stripped (`" a , b "` gives `[" a ", " b "]`).
- A field is *quoted* when its **first** character is `"`. Inside a quoted field, the delimiter and
  newlines are ordinary characters and `""` stands for one literal `"`. The surrounding quotes are not
  part of the value (`'""'` is an empty field).
- After the closing quote of a quoted field, the next character must be the delimiter or the end of the
  line; anything else (e.g. `'"a"b'`) raises `ValueError`.
- A quoted field without a closing quote raises `ValueError`.
- A `"` that is not the first character of a field is an ordinary character (`'ab"c'` stays `'ab"c'`,
  and `' "x"'` stays `' "x"'` because the field starts with a space).

## Examples

```python
>>> split_csv_line('a,b,c')
['a', 'b', 'c']
>>> split_csv_line('"a,b",c')
['a,b', 'c']
>>> split_csv_line('"say ""hi""",x')
['say "hi"', 'x']
>>> split_csv_line('a,b,')
['a', 'b', '']
>>> split_csv_line('x;"y;z"', delimiter=';')
['x', 'y;z']
```
