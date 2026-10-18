# Dedent a block of text

A templating engine lets users write indented multi-line strings in their source code and needs to
remove the common indentation before rendering them. Tabs and spaces are not interchangeable.

## Function

```python
def dedent(text: str) -> str
```

## Rules

- If `text` starts with a newline (as triple-quoted strings often do), remove that **one** leading
  `"\n"` first. Only one is removed.
- Split the text into lines on `"\n"`.
- Whitespace here means spaces and tabs only. A line is *blank* if it is empty or contains only spaces
  and tabs.
- Compute the longest common leading-whitespace **prefix** of all non-blank lines, comparing
  character by character. Tabs are never expanded or converted, so `"\t"` and `"    "` have no common
  prefix, while `"\t    "` and `"\t  "` share the prefix `"\t  "`.
- Remove that prefix from every non-blank line. Blank lines become empty strings, and they do not
  affect the common prefix.
- Join the lines with `"\n"` again. A trailing newline stays, and trailing whitespace at the end of
  non-blank lines is kept. `""` returns `""`.

## Examples

```python
>>> dedent("    a\n      b\n    c")
'a\n  b\nc'
>>> dedent("\n    x = 1\n\n    y = 2\n")
'x = 1\n\ny = 2\n'
>>> dedent("\ta\n    b")
'\ta\n    b'
>>> dedent("\t\ta\n\tb")
'\ta\nb'
```
