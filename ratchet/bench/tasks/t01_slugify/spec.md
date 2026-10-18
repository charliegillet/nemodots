# Slugify

Turn arbitrary titles into URL slugs for a blog engine. Slugs must be pure ASCII, lowercase, and
safe to put in a URL. Titles come from users, so expect accents, symbols, emoji and odd spacing.

## Function

```python
def slugify(text: str, max_length: int | None = None, separator: str = "-") -> str
```

## Rules

- First normalize `text` with Unicode **NFKD** (`unicodedata.normalize("NFKD", text)`), then drop every
  character that is not ASCII. This turns `"Crème"` into `"Creme"`, the ligature `"ﬁ"` into `"fi"`
  and `"①"` into `"1"`, and removes characters such as `"東"` entirely.
- Lowercase the result.
- Words are the maximal runs of ASCII letters and digits (`a-z`, `0-9`). Everything else (spaces,
  punctuation, apostrophes, underscores, hyphens, ...) only separates words.
- The slug is the words joined by `separator` (default `"-"`; it may be longer than one character).
  There is never a separator at the start or end, and never two separators in a row.
- If there are no words, return `""`.
- `max_length=None` means no limit. Otherwise the slug must be at most `max_length` characters and is
  cut at a word boundary: keep the longest run of leading whole words (joined by `separator`) that
  fits. Never end with a separator and never cut a word in half, with one exception: if even the
  first word alone is longer than `max_length`, return the first `max_length` characters of that word.
- `max_length` smaller than 1 raises `ValueError`.

## Examples

```python
>>> slugify("Hello, World!")
'hello-world'
>>> slugify("Crème Brûlée")
'creme-brulee'
>>> slugify("The quick brown fox", max_length=12)
'the-quick'
>>> slugify("Supercalifragilistic word", max_length=5)
'super'
>>> slugify("Hello World", separator="_")
'hello_world'
```
