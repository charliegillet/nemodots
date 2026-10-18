import pytest

from solution import from_roman, to_roman


def test_to_roman_small_values_and_subtractive_pairs():
    expected = {1: "I", 3: "III", 4: "IV", 9: "IX", 14: "XIV", 40: "XL", 90: "XC", 400: "CD", 900: "CM"}
    for n, numeral in expected.items():
        assert to_roman(n) == numeral


def test_to_roman_full_numbers():
    assert to_roman(1994) == "MCMXCIV"
    assert to_roman(2024) == "MMXXIV"
    assert to_roman(3888) == "MMMDCCCLXXXVIII"


def test_to_roman_upper_bound_3999():
    assert to_roman(3999) == "MMMCMXCIX"


def test_to_roman_out_of_range_raises():
    for n in [0, -1, 4000, 10000]:
        with pytest.raises(ValueError):
            to_roman(n)


def test_from_roman_basic():
    assert from_roman("MCMXCIV") == 1994
    assert from_roman("XLII") == 42
    assert from_roman("I") == 1
    assert from_roman("MMMCMXCIX") == 3999


def test_from_roman_accepts_lowercase_and_mixed_case():
    assert from_roman("mcmxciv") == 1994
    assert from_roman("McMxCiV") == 1994
    assert from_roman("iv") == 4


def test_round_trip_every_value():
    for n in range(1, 4000):
        numeral = to_roman(n)
        assert from_roman(numeral) == n
        assert from_roman(numeral.lower()) == n


def test_from_roman_rejects_too_many_repeats():
    for bad in ["IIII", "VV", "XXXX", "LL", "CCCC", "DD", "MMMM"]:
        with pytest.raises(ValueError):
            from_roman(bad)


def test_from_roman_rejects_invalid_subtraction():
    for bad in ["VX", "IC", "IL", "XM", "IIX", "VL", "IM"]:
        with pytest.raises(ValueError):
            from_roman(bad)


def test_from_roman_rejects_non_canonical_orderings():
    for bad in ["IVI", "XCX", "IXI", "CMC"]:
        with pytest.raises(ValueError):
            from_roman(bad)


def test_from_roman_rejects_empty_and_other_characters():
    for bad in ["", " ", "X I", "12", "ABC", "XIV ", "X-I"]:
        with pytest.raises(ValueError):
            from_roman(bad)
