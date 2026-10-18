import pytest

from solution import slugify


def test_basic_lowercase_and_spaces():
    assert slugify("Hello World") == "hello-world"


def test_punctuation_runs_collapse_to_one_separator():
    assert slugify("Hello,   World!! How's it going?") == "hello-world-how-s-it-going"


def test_digits_are_kept():
    assert slugify("Top 10 Tips for 2024") == "top-10-tips-for-2024"


def test_accents_are_transliterated_not_dropped():
    assert slugify("Crème Brûlée à la carte") == "creme-brulee-a-la-carte"


def test_compatibility_characters_are_decomposed_with_nfkd():
    assert slugify("ﬁnal ① draft") == "final-1-draft"


def test_non_latin_characters_are_dropped():
    assert slugify("東京 Tokyo 2024 🚀") == "tokyo-2024"


def test_no_leading_or_trailing_separators():
    assert slugify("  --Hello__World--  ") == "hello-world"


def test_input_without_words_gives_empty_string():
    assert slugify("") == ""
    assert slugify("!!! ??? ...") == ""


def test_max_length_cuts_at_word_boundary():
    assert slugify("The quick brown fox", max_length=12) == "the-quick"


def test_max_length_exact_fit_keeps_the_word():
    assert slugify("The quick brown fox", max_length=15) == "the-quick-brown"
    assert slugify("The quick brown fox", max_length=14) == "the-quick"


def test_max_length_never_ends_with_separator():
    assert slugify("The quick brown fox", max_length=10) == "the-quick"
    assert slugify("ab cd", max_length=3) == "ab"


def test_first_word_longer_than_max_length_is_truncated():
    assert slugify("Supercalifragilistic word", max_length=5) == "super"


def test_custom_and_multi_character_separators():
    assert slugify("Hello World", separator="_") == "hello_world"
    assert slugify("a b c", separator="--") == "a--b--c"
    assert slugify("a b c", max_length=4, separator="--") == "a--b"


def test_max_length_none_means_unlimited():
    text = " ".join(["word"] * 50)
    assert slugify(text) == "-".join(["word"] * 50)
    assert slugify(text, max_length=None) == "-".join(["word"] * 50)


def test_invalid_max_length_raises_value_error():
    with pytest.raises(ValueError):
        slugify("hello", max_length=0)
    with pytest.raises(ValueError):
        slugify("hello", max_length=-3)
    assert slugify("hello world", max_length=1) == "h"
