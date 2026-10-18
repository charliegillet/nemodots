import pytest

from solution import parse_size


def test_bare_number_is_bytes():
    assert parse_size("512") == 512
    assert parse_size("0") == 0


def test_explicit_bytes_unit():
    assert parse_size("512B") == 512
    assert parse_size("512 b") == 512


def test_decimal_units_are_powers_of_1000():
    assert parse_size("1KB") == 1000
    assert parse_size("1MB") == 1000 ** 2
    assert parse_size("1GB") == 1000 ** 3
    assert parse_size("2TB") == 2 * 1000 ** 4
    assert parse_size("1PB") == 1000 ** 5


def test_binary_units_are_powers_of_1024():
    assert parse_size("1KiB") == 1024
    assert parse_size("1MiB") == 1024 ** 2
    assert parse_size("1GiB") == 1024 ** 3
    assert parse_size("3TiB") == 3 * 1024 ** 4
    assert parse_size("1PiB") == 1024 ** 5


def test_units_are_case_insensitive():
    assert parse_size("1gib") == 1024 ** 3
    assert parse_size("1GIB") == 1024 ** 3
    assert parse_size("1kb") == 1000
    assert parse_size("1 Mb") == 1000 ** 2


def test_whitespace_is_allowed_around_and_between():
    assert parse_size("  2 MiB  ") == 2 * 1024 ** 2
    assert parse_size("2MiB") == 2 * 1024 ** 2
    assert parse_size("2\tKB") == 2000


def test_fractional_values():
    assert parse_size("1.5 KiB") == 1536
    assert parse_size("1.5KB") == 1500
    assert parse_size("0.5 GiB") == 1024 ** 3 // 2


def test_exact_arithmetic_without_float_error():
    assert parse_size("4.35 MB") == 4350000
    assert parse_size("0.1 KB") == 100
    assert parse_size("1.1 GB") == 1100000000
    assert parse_size("8.2 TB") == 8200000000000


def test_rounding_to_nearest_with_halves_up():
    assert parse_size("1.001 KiB") == 1025
    assert parse_size("1.5 B") == 2
    assert parse_size("2.5 B") == 3
    assert parse_size("0.0005 KB") == 1
    assert parse_size("1.4 B") == 1


def test_empty_or_unitless_garbage_raises():
    for bad in ["", "   ", "abc", "KB", "GiB"]:
        with pytest.raises(ValueError):
            parse_size(bad)


def test_signs_raise():
    for bad in ["-1KB", "+1KB", "-0"]:
        with pytest.raises(ValueError):
            parse_size(bad)


def test_unknown_units_raise():
    for bad in ["4 XB", "1 K", "1 KBi", "1 bytes", "1 Gb2", "1 iB"]:
        with pytest.raises(ValueError):
            parse_size(bad)


def test_malformed_numbers_raise():
    for bad in ["1,000", "1.2.3 KB", ".5 KB", "5. KB", "1 2 KB", "1e3", "1_000"]:
        with pytest.raises(ValueError):
            parse_size(bad)
