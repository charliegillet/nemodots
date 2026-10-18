# Word wrap

A terminal UI needs to wrap help text to the window width. Implement a greedy word wrapper with
precisely defined behaviour for long words and blank lines.

## Function

```python
def wrap(text: str, width: int) -> list[str]
```

## Rules

- `width` must be at least 1; otherwise raise `ValueError`.
- Split `text` into input lines on `"\n"` and wrap every input line independently; words never move
  from one input line to another. The output is the concatenation of the wrapped lines.
- Within an input line, words are the runs of non-whitespace characters; whitespace (spaces, tabs)
  only separates words and is not preserved. Output lines are words joined by single spaces, with no
  leading or trailing whitespace.
- Greedy filling: put as many words on the current output line as fit within `width` characters, then
  start a new line.
- A word longer than `width` is broken: if the current output line is not empty, finish it first; then
  emit chunks of exactly `width` characters, each on its own line. The final, shorter-or-equal chunk
  becomes the current line, and following words may join it if they fit. A word of exactly `width`
  characters is not broken.
- An input line that is empty or contains only whitespace produces one empty string `""` in the output
  (blank lines are preserved). Consequently `wrap("", 10)` is `[""]` and `wrap("abc\n", 10)` is
  `["abc", ""]`.

## Examples

```python
>>> wrap("the quick brown fox jumps over the lazy dog", 10)
['the quick', 'brown fox', 'jumps over', 'the lazy', 'dog']
>>> wrap("abcdefghij", 4)
['abcd', 'efgh', 'ij']
>>> wrap("abcdefg hi", 6)
['abcdef', 'g hi']
>>> wrap("one two\n\nthree", 20)
['one two', '', 'three']
```
