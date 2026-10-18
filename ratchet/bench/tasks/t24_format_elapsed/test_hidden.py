import pytest

from solution import format_elapsed


def test_zero():
    assert format_elapsed(0) == "0s"
    assert format_elapsed(0.0) == "0s"


def test_seconds_only():
    assert format_elapsed(45) == "45s"
    assert format_elapsed(1) == "1s"


def test_minutes_and_seconds():
    assert format_elapsed(61) == "1m 1s"
    assert format_elapsed(600) == "10m"


def test_exact_hour_omits_zero_units():
    assert format_elapsed(3600) == "1h"
    assert format_elapsed(7200) == "2h"


def test_zero_units_in_the_middle_are_omitted():
    assert format_elapsed(3605) == "1h 5s"
    assert format_elapsed(86460) == "1d 1m"
    assert format_elapsed(86401) == "1d 1s"


def test_all_units():
    assert format_elapsed(90061) == "1d 1h 1m 1s"
    assert format_elapsed(1_000_000) == "11d 13h 46m 40s"


def test_days_are_the_largest_unit():
    assert format_elapsed(864000) == "10d"
    assert format_elapsed(400 * 86400 + 3) == "400d 3s"


def test_rounding_below_half():
    assert format_elapsed(0.4) == "0s"
    assert format_elapsed(1.49) == "1s"


def test_halves_round_up_not_to_even():
    assert format_elapsed(0.5) == "1s"
    assert format_elapsed(1.5) == "2s"
    assert format_elapsed(2.5) == "3s"
    assert format_elapsed(4.5) == "5s"


def test_rounding_carries_into_larger_units():
    assert format_elapsed(59.5) == "1m"
    assert format_elapsed(3599.6) == "1h"
    assert format_elapsed(86399.5) == "1d"


def test_negative_values_raise():
    for value in [-1, -0.4, -86400]:
        with pytest.raises(ValueError):
            format_elapsed(value)


def test_nan_and_infinity_raise():
    for value in [float("nan"), float("inf")]:
        with pytest.raises(ValueError):
            format_elapsed(value)
