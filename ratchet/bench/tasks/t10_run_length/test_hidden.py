import pytest

from solution import decode, encode


def test_encode_basic_runs():
    assert encode("aaabccdddd") == "3a1b2c4d"


def test_encode_writes_count_one():
    assert encode("abc") == "1a1b1c"


def test_encode_multi_digit_counts():
    assert encode("a" * 12 + "b") == "12a1b"
    assert encode("z" * 100) == "100z"


def test_encode_escapes_digits():
    assert encode("111223") == "3\\12\\21\\3"
    assert encode("a1") == "1a1\\1"


def test_encode_escapes_backslashes():
    assert encode("a\\\\b") == "1a2\\\\1b"


def test_encode_is_case_sensitive_and_handles_whitespace():
    assert encode("aAa") == "1a1A1a"
    assert encode("  \n") == "2 1\n"


def test_decode_basic_and_multi_digit():
    assert decode("3a1b2c4d") == "aaabccdddd"
    assert decode("12a1b") == "a" * 12 + "b"


def test_decode_escaped_characters():
    assert decode("3\\1") == "111"
    assert decode("2\\\\1x") == "\\\\x"
    assert decode("1\\a") == "a"


def test_empty_string():
    assert encode("") == ""
    assert decode("") == ""


def test_round_trip():
    samples = ["a1b2", "1" * 15, "\\\\\\", "  \n\n", "日本日本本", "x" * 100, "0", "9\\9", "abc123\\\\321cba",
               "a" * 10 + "1" * 10, "\t\t5"]
    for s in samples:
        assert decode(encode(s)) == s


def test_decode_rejects_missing_count():
    for bad in ["a", "\\1", "3ab"]:
        with pytest.raises(ValueError):
            decode(bad)


def test_decode_rejects_count_without_character():
    for bad in ["3", "3a4"]:
        with pytest.raises(ValueError):
            decode(bad)


def test_decode_rejects_zero_count():
    with pytest.raises(ValueError):
        decode("0a")
    with pytest.raises(ValueError):
        decode("2a00b")


def test_decode_rejects_dangling_backslash():
    with pytest.raises(ValueError):
        decode("2\\")
