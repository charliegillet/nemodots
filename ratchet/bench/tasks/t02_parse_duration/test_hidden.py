import pytest

from solution import parse_duration


def test_single_units():
    assert parse_duration("45s") == 45
    assert parse_duration("2m") == 120
    assert parse_duration("3h") == 10800
    assert parse_duration("1d") == 86400


def test_combined_components():
    assert parse_duration("1h30m") == 5400
    assert parse_duration("1d2h3m4s") == 93784


def test_components_in_any_order():
    assert parse_duration("30m1h") == 5400
    assert parse_duration("4s 3m 2h 1d") == 93784


def test_whitespace_allowed_everywhere():
    assert parse_duration("  1 h  30 m  ") == 5400
    assert parse_duration("\t2d\n") == 172800


def test_units_are_case_insensitive():
    assert parse_duration("1H30M") == 5400
    assert parse_duration("1D 1S") == 86401


def test_zero_values_are_valid():
    assert parse_duration("0s") == 0
    assert parse_duration("0h 5m") == 300


def test_large_values_are_not_normalized_or_rejected():
    assert parse_duration("90m") == 5400
    assert parse_duration("100h") == 360000
    assert parse_duration("3600s") == 3600


def test_empty_or_blank_raises():
    for text in ["", "   ", "\n"]:
        with pytest.raises(ValueError):
            parse_duration(text)


def test_number_without_unit_raises():
    for text in ["90", "1h 30", "5 "]:
        with pytest.raises(ValueError):
            parse_duration(text)


def test_unknown_unit_raises():
    for text in ["5w", "10ms", "3x", "2 hours"]:
        with pytest.raises(ValueError):
            parse_duration(text)


def test_signs_are_rejected():
    for text in ["-5m", "1h -5m", "+5m"]:
        with pytest.raises(ValueError):
            parse_duration(text)


def test_decimals_are_rejected():
    for text in ["1.5h", "0.5s"]:
        with pytest.raises(ValueError):
            parse_duration(text)


def test_repeated_unit_raises():
    for text in ["1h 2h", "5m 5M", "1s2s"]:
        with pytest.raises(ValueError):
            parse_duration(text)


def test_other_characters_raise():
    for text in ["1h,30m", "h", "1h30m!", "1h_30m"]:
        with pytest.raises(ValueError):
            parse_duration(text)
