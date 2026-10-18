from datetime import date

import pytest

from solution import add_months


def test_simple_forward():
    assert add_months(date(2024, 1, 15), 1) == date(2024, 2, 15)
    assert add_months(date(2024, 3, 1), 5) == date(2024, 8, 1)


def test_year_rollover_forward():
    assert add_months(date(2023, 11, 15), 2) == date(2024, 1, 15)
    assert add_months(date(2023, 12, 1), 1) == date(2024, 1, 1)


def test_negative_months_cross_year():
    assert add_months(date(2024, 2, 10), -3) == date(2023, 11, 10)
    assert add_months(date(2024, 1, 31), -1) == date(2023, 12, 31)
    assert add_months(date(2024, 1, 31), -13) == date(2022, 12, 31)


def test_zero_months_returns_same_date():
    assert add_months(date(2024, 2, 29), 0) == date(2024, 2, 29)


def test_end_of_month_clamp():
    assert add_months(date(2023, 1, 31), 1) == date(2023, 2, 28)
    assert add_months(date(2024, 5, 31), 1) == date(2024, 6, 30)
    assert add_months(date(2024, 8, 31), -2) == date(2024, 6, 30)


def test_clamp_to_leap_day():
    assert add_months(date(2024, 1, 31), 1) == date(2024, 2, 29)
    assert add_months(date(2024, 3, 31), -1) == date(2024, 2, 29)
    assert add_months(date(2023, 3, 31), -1) == date(2023, 2, 28)


def test_leap_day_plus_years():
    assert add_months(date(2024, 2, 29), 12) == date(2025, 2, 28)
    assert add_months(date(2024, 2, 29), 48) == date(2028, 2, 29)
    assert add_months(date(2024, 2, 29), -12) == date(2023, 2, 28)


def test_century_leap_rules():
    assert add_months(date(1900, 1, 31), 1) == date(1900, 2, 28)
    assert add_months(date(2000, 1, 31), 1) == date(2000, 2, 29)
    assert add_months(date(2100, 3, 29), -1) == date(2100, 2, 28)


def test_computed_from_original_date_not_iteratively():
    assert add_months(date(2023, 1, 31), 2) == date(2023, 3, 31)
    assert add_months(date(2023, 1, 30), 13) == date(2024, 2, 29)


def test_large_offsets():
    assert add_months(date(2024, 1, 15), 120) == date(2034, 1, 15)
    assert add_months(date(2024, 1, 15), -1200) == date(1924, 1, 15)
    assert add_months(date(2024, 10, 31), 1000) == date(2108, 2, 29)


def test_returns_a_date():
    result = add_months(date(2024, 1, 15), 1)
    assert type(result) is date


def test_extreme_valid_years():
    assert add_months(date(1, 2, 28), -1) == date(1, 1, 28)
    assert add_months(date(9999, 11, 30), 1) == date(9999, 12, 30)


def test_out_of_range_raises():
    with pytest.raises(ValueError):
        add_months(date(9999, 12, 15), 1)
    with pytest.raises(ValueError):
        add_months(date(1, 1, 1), -1)
