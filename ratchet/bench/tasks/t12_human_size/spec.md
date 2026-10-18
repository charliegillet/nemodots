# Parse human-readable sizes

A storage quota tool reads limits such as `"1.5 GiB"` or `"500MB"` from YAML files. Convert them to
an exact number of bytes. Decimal and binary units are different and both must be supported.

## Function

```python
def parse_size(text: str) -> int
```

## Rules

- Format: optional surrounding whitespace, a number, optional whitespace, an optional unit.
- The number is written with ASCII digits and an optional fractional part: `"12"`, `"1.5"`, `"0.25"`.
  At least one digit is required on each side of a decimal point (`".5"` and `"5."` are invalid).
  No signs, no thousands separators, no exponents.
- Units (case-insensitive):
  - `B` = 1 byte (a bare number with no unit also means bytes);
  - decimal units: `KB` = 1000, `MB` = 1000², `GB` = 1000³, `TB` = 1000⁴, `PB` = 1000⁵ bytes;
  - binary units: `KiB` = 1024, `MiB` = 1024², `GiB` = 1024³, `TiB` = 1024⁴, `PiB` = 1024⁵ bytes.
  No other unit is accepted (not `K`, `M`, `bytes`, `KBi`, ...).
- The result is `number * unit` computed **exactly** (no floating-point error: `"4.35 MB"` is exactly
  `4350000`). If it is not a whole number of bytes, round to the nearest integer with halves rounded
  **up** (`"1.5 B"` is `2`, `"2.5 B"` is `3`).
- Return an `int`. Anything that does not match the format raises `ValueError`.

## Examples

```python
>>> parse_size("512")
512
>>> parse_size("1 KB")
1000
>>> parse_size("1KiB")
1024
>>> parse_size("1.5 gib")
1610612736
>>> parse_size("4.35 MB")
4350000
```
