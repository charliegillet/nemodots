# Compare semantic versions

A package manager must decide which of two release tags is newer. Versions follow Semantic Versioning
2.0.0 precedence rules, with one convenience: an optional leading `v`.

## Function

```python
def compare_versions(a: str, b: str) -> int
```

Return `-1` if `a` has lower precedence than `b`, `0` if equal precedence, `1` if higher.

## Rules

- Format: `[v|V]MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`.
- `MAJOR`, `MINOR`, `PATCH` are non-negative integers without leading zeros (`0` is fine, `01` is not).
  They are compared numerically, in that order (`1.10.0` is newer than `1.9.0`).
- `PRERELEASE` (after the first `-`) is a non-empty dot-separated list of non-empty identifiers made of
  ASCII letters, digits and `-`. An identifier made only of digits is *numeric* and must not have
  leading zeros (`alpha.01` is invalid).
- A version with a prerelease has **lower** precedence than the same version without one
  (`1.0.0-alpha < 1.0.0`).
- Prerelease identifiers are compared one by one, left to right:
  - numeric vs numeric: compared as integers (`alpha.2 < alpha.10`);
  - alphanumeric vs alphanumeric: compared as strings in ASCII order (`Beta < alpha` because uppercase
    letters sort before lowercase ones);
  - numeric identifiers always have lower precedence than alphanumeric ones (`1.0.0-1 < 1.0.0-a`);
  - if all compared identifiers are equal, the version with more identifiers is higher
    (`alpha < alpha.1`).
- `BUILD` (after `+`) is a non-empty dot-separated list of non-empty identifiers (letters, digits,
  `-`) and is **ignored** for precedence (`1.0.0+a` equals `1.0.0+b`).
- Anything else raises `ValueError`, for example `"1.0"`, `"1.0.0.0"`, `"1.x.0"`, `""`, `"1.0.0-"`,
  `"1.0.0+"`, `"01.0.0"`.

## Examples

```python
>>> compare_versions("1.10.0", "1.9.0")
1
>>> compare_versions("1.0.0-alpha", "1.0.0")
-1
>>> compare_versions("1.0.0-alpha.2", "1.0.0-alpha.10")
-1
>>> compare_versions("v1.2.3+build.7", "1.2.3")
0
>>> compare_versions("1.0", "1.0.0")
Traceback (most recent call last):
ValueError: ...
```
