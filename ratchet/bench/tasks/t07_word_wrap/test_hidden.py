import pytest

from solution import wrap


def test_basic_greedy_wrap():
    assert wrap("the quick brown fox jumps over the lazy dog", 10) == [
        "the quick", "brown fox", "jumps over", "the lazy", "dog"]


def test_exact_fit_and_one_over():
    assert wrap("abc def", 7) == ["abc def"]
    assert wrap("abc def", 6) == ["abc", "def"]


def test_long_word_is_broken_into_width_chunks():
    assert wrap("abcdefghij", 4) == ["abcd", "efgh", "ij"]
    assert wrap("abcdefgh", 4) == ["abcd", "efgh"]


def test_long_word_starts_on_a_new_line():
    assert wrap("hi abcdefghij", 4) == ["hi", "abcd", "efgh", "ij"]


def test_last_chunk_can_be_followed_by_words():
    assert wrap("abcdefg hi", 6) == ["abcdef", "g hi"]
    assert wrap("abcdefg hi there", 6) == ["abcdef", "g hi", "there"]


def test_word_of_exactly_width_is_not_broken():
    assert wrap("abcd ef", 4) == ["abcd", "ef"]


def test_blank_lines_are_preserved():
    assert wrap("one two\n\nthree", 20) == ["one two", "", "three"]
    assert wrap("a\n\n\nb", 5) == ["a", "", "", "b"]


def test_whitespace_only_line_becomes_empty_string():
    assert wrap("a\n   \t \nb", 5) == ["a", "", "b"]


def test_whitespace_is_collapsed_and_trimmed():
    assert wrap("  a    b  ", 10) == ["a b"]
    assert wrap("a\t\tb", 10) == ["a b"]


def test_input_lines_are_wrapped_independently():
    assert wrap("aa bb\ncc dd", 5) == ["aa bb", "cc dd"]
    assert wrap("a\nb", 10) == ["a", "b"]


def test_empty_text_and_trailing_newline():
    assert wrap("", 10) == [""]
    assert wrap("abc\n", 10) == ["abc", ""]


def test_width_one():
    assert wrap("ab c", 1) == ["a", "b", "c"]


def test_invalid_width_raises():
    for width in [0, -1]:
        with pytest.raises(ValueError):
            wrap("text", width)


def test_no_line_exceeds_width():
    text = "lorem ipsum dolor sit amet consectetur adipiscingelitseddoeiusmod tempor incididunt ut labore"
    for width in range(1, 30):
        lines = wrap(text, width)
        assert all(len(line) <= width for line in lines)
        assert "".join(lines).replace(" ", "") == text.replace(" ", "")
