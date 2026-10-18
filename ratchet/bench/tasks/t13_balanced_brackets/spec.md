# Balanced brackets in code

A code editor highlights unbalanced brackets. Brackets that appear inside string literals must not
count, so a plain bracket counter is not enough.

## Function

```python
def is_balanced(code: str) -> bool
```

## Rules

- The bracket pairs are `()`, `[]` and `{}`. Return `True` when every opening bracket is closed by the
  matching bracket in the correct nesting order and no closing bracket appears without a matching
  opening one. `"([)]"` and `"(]"` are not balanced.
- String literals are ignored: a string starts with a single quote `'` or a double quote `"` and ends
  at the next **unescaped** occurrence of the same quote character. Everything inside a string is
  ignored, including brackets and the other kind of quote (`"it's"` is one complete string).
- Inside a string, a backslash escapes the next character, whatever it is: `\"` does not end a
  double-quoted string, and `\\` is an escaped backslash (so in `"\\"` the second `"` does end the
  string).
- Outside strings, a backslash is an ordinary character.
- A string that is never closed makes the code unbalanced (return `False`).
- All other characters are ignored. The empty string is balanced.

## Examples

```python
>>> is_balanced("f(a[0], {b: c})")
True
>>> is_balanced("([)]")
False
>>> is_balanced('print(")")')
True
>>> is_balanced('f("abc)')
False
```
