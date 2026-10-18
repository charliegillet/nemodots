from datetime import datetime

import pytest

from solution import cron_matches

SUNDAY = datetime(2026, 10, 18, 0, 0)
MONDAY = datetime(2026, 10, 19, 0, 0)
FRIDAY_16TH = datetime(2026, 10, 16, 0, 0)
TUESDAY_13TH = datetime(2026, 10, 13, 0, 0)
WEDNESDAY_14TH = datetime(2026, 10, 14, 0, 0)
FRIDAY_13TH = datetime(2026, 11, 13, 0, 0)


def test_every_minute():
    assert cron_matches("* * * * *", datetime(2026, 10, 17, 13, 37))


def test_exact_minute_and_hour():
    assert cron_matches("30 9 * * *", datetime(2026, 10, 17, 9, 30))
    assert not cron_matches("30 9 * * *", datetime(2026, 10, 17, 9, 31))
    assert not cron_matches("30 9 * * *", datetime(2026, 10, 17, 10, 30))


def test_seconds_are_ignored():
    assert cron_matches("30 9 * * *", datetime(2026, 10, 17, 9, 30, 59, 999))


def test_step_from_star():
    for minute in [0, 15, 30, 45]:
        assert cron_matches("*/15 * * * *", datetime(2026, 10, 17, 8, minute))
    for minute in [1, 10, 14, 59]:
        assert not cron_matches("*/15 * * * *", datetime(2026, 10, 17, 8, minute))


def test_hour_range_is_inclusive():
    assert cron_matches("0 9-17 * * *", datetime(2026, 10, 17, 9, 0))
    assert cron_matches("0 9-17 * * *", datetime(2026, 10, 17, 17, 0))
    assert not cron_matches("0 9-17 * * *", datetime(2026, 10, 17, 8, 0))
    assert not cron_matches("0 9-17 * * *", datetime(2026, 10, 17, 18, 0))


def test_lists_and_range_with_step():
    assert cron_matches("0,30 * * * *", datetime(2026, 10, 17, 1, 30))
    assert not cron_matches("0,30 * * * *", datetime(2026, 10, 17, 1, 15))
    for minute in [10, 20, 30]:
        assert cron_matches("10-30/10 * * * *", datetime(2026, 10, 17, 1, minute))
    for minute in [0, 15, 40]:
        assert not cron_matches("10-30/10 * * * *", datetime(2026, 10, 17, 1, minute))
    assert cron_matches("5,10-12,*/50 * * * *", datetime(2026, 10, 17, 1, 11))
    assert cron_matches("5,10-12,*/50 * * * *", datetime(2026, 10, 17, 1, 50))


def test_month_field_and_maximum_values():
    assert cron_matches("0 0 1 1 *", datetime(2027, 1, 1, 0, 0))
    assert cron_matches("59 23 31 12 *", datetime(2026, 12, 31, 23, 59))
    assert cron_matches("* * * * *", datetime(2026, 12, 31, 23, 59))
    assert cron_matches("5-5 * * * *", datetime(2026, 12, 31, 23, 5))
    assert not cron_matches("0 0 1 1 *", datetime(2027, 2, 1, 0, 0))


def test_sunday_is_both_0_and_7():
    assert cron_matches("0 0 * * 0", SUNDAY)
    assert cron_matches("0 0 * * 7", SUNDAY)
    assert not cron_matches("0 0 * * 0", MONDAY)
    assert cron_matches("0 0 * * 5-7", SUNDAY)


def test_weekday_range():
    assert cron_matches("0 0 * * 1-5", MONDAY)
    assert cron_matches("0 0 * * 1-5", FRIDAY_16TH)
    assert not cron_matches("0 0 * * 1-5", SUNDAY)
    assert not cron_matches("0 0 * * 1-5", datetime(2026, 10, 17, 0, 0))


def test_day_of_month_and_weekday_both_restricted_means_either():
    assert cron_matches("0 0 13 * 5", FRIDAY_16TH)
    assert cron_matches("0 0 13 * 5", TUESDAY_13TH)
    assert cron_matches("0 0 13 * 5", FRIDAY_13TH)
    assert not cron_matches("0 0 13 * 5", WEDNESDAY_14TH)


def test_only_day_of_month_restricted():
    assert cron_matches("0 0 13 * *", TUESDAY_13TH)
    assert not cron_matches("0 0 13 * *", FRIDAY_16TH)


def test_only_weekday_restricted():
    assert cron_matches("0 0 * * 5", FRIDAY_16TH)
    assert not cron_matches("0 0 * * 5", TUESDAY_13TH)


def test_step_in_day_field_still_counts_as_restricted():
    assert cron_matches("0 0 */2 * 1", MONDAY)
    assert cron_matches("0 0 */2 * 1", datetime(2026, 10, 15, 0, 0))
    assert not cron_matches("0 0 */2 * 1", WEDNESDAY_14TH)


def test_wrong_field_count_raises():
    for expr in ["* * * *", "* * * * * *", ""]:
        with pytest.raises(ValueError):
            cron_matches(expr, MONDAY)


def test_invalid_items_raise():
    bad = ["60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 13 *", "* * * 0 *",
           "* * * * 8", "*/0 * * * *", "5-1 * * * *", "1,,2 * * * *", "* * * JAN *", "* * * * MON",
           "5/15 * * * *", "-1 * * * *", "+5 * * * *", "1-2-3 * * * *", "a * * * *"]
    for expr in bad:
        with pytest.raises(ValueError):
            cron_matches(expr, MONDAY)
