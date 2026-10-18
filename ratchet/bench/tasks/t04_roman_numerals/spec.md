# Roman numerals

A document generator numbers appendices and front matter with Roman numerals and also has to read
them back from user input. Only the standard, canonical modern form is allowed.

## Functions

```python
def to_roman(n: int) -> str
def from_roman(s: str) -> int
```

## Rules

- Symbols: `I`=1, `V`=5, `X`=10, `L`=50, `C`=100, `D`=500, `M`=1000. The canonical form uses the
  subtractive pairs `IV`=4, `IX`=9, `XL`=40, `XC`=90, `CD`=400, `CM`=900 and writes values from largest
  to smallest (1994 is `MCMXCIV`).
- `to_roman` accepts integers from 1 to 3999 inclusive and returns the canonical uppercase numeral.
  Any other value (0, negative, 4000 or more) raises `ValueError`.
- `from_roman` accepts upper- or lowercase letters (also mixed case) and returns the integer.
- `from_roman` only accepts the canonical form: a string is valid exactly when it equals
  `to_roman(value)` after uppercasing. So it rejects with `ValueError`:
  - too many repeats, e.g. `"IIII"`, `"VV"`, `"XXXX"`, `"MMMM"`;
  - invalid subtractions, e.g. `"VX"`, `"IC"`, `"IL"`, `"XM"`, `"IIX"`;
  - the empty string, spaces, digits or any other character.

## Examples

```python
>>> to_roman(1994)
'MCMXCIV'
>>> to_roman(4)
'IV'
>>> from_roman("mcmxciv")
1994
>>> from_roman("IIII")
Traceback (most recent call last):
ValueError: ...
```
