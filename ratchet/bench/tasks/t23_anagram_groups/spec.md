# Group anagrams

A word-game helper groups the player's guesses that are anagrams of each other. Players type with
random capitalisation and sometimes enter phrases, so comparison is forgiving, but the output must
show exactly what they typed.

## Function

```python
def group_anagrams(words: list[str]) -> list[list[str]]
```

## Rules

- Two strings are anagrams when, after lowercasing them (`str.lower()`) and removing **space**
  characters (`" "` only), they contain exactly the same characters with the same multiplicities.
  Punctuation, digits and other whitespace still count.
- Return a list of groups. Each group is a list of the **original** strings (not lowercased, spaces
  kept) in the order they appear in `words`.
- Groups are ordered by the position of their first member in `words` (do not sort groups or words).
- Duplicates are kept: every input string appears exactly once in the output, in its group.
- Strings that become empty after removing spaces (`""`, `"  "`) are anagrams of each other.
- An empty input returns `[]`. Do not modify `words`.

## Examples

```python
>>> group_anagrams(["eat", "tea", "tan", "ate", "nat", "bat"])
[['eat', 'tea', 'ate'], ['tan', 'nat'], ['bat']]
>>> group_anagrams(["Listen", "Silent", "enlist"])
[['Listen', 'Silent', 'enlist']]
>>> group_anagrams(["dormitory", "dirty room", "dirty room!"])
[['dormitory', 'dirty room'], ['dirty room!']]
```
