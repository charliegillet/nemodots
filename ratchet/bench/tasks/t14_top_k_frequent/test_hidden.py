import pytest

from solution import top_k_frequent


def test_basic_most_frequent_first():
    assert top_k_frequent(["a", "b", "a", "c", "b", "a"], 2) == ["a", "b"]


def test_full_ordering_by_count():
    items = ["c"] * 1 + ["b"] * 3 + ["a"] * 2
    assert top_k_frequent(items, 3) == ["b", "a", "c"]


def test_ties_broken_by_first_occurrence_not_alphabetically():
    assert top_k_frequent(["pear", "apple", "pear", "apple", "fig"], 2) == ["pear", "apple"]
    assert top_k_frequent(["b", "a"], 2) == ["b", "a"]


def test_ties_use_first_occurrence_even_if_later_items_catch_up():
    items = ["z", "y", "x", "y", "z", "x"]
    assert top_k_frequent(items, 3) == ["z", "y", "x"]


def test_tie_order_with_higher_counts_interleaved():
    items = ["d", "c", "c", "b", "b", "a", "a", "a"]
    assert top_k_frequent(items, 4) == ["a", "c", "b", "d"]


def test_k_larger_than_distinct_returns_all():
    assert top_k_frequent(["x", "y", "x"], 10) == ["x", "y"]


def test_k_equal_to_distinct_count():
    assert top_k_frequent(["x", "y", "z"], 3) == ["x", "y", "z"]


def test_k_zero_returns_empty():
    assert top_k_frequent(["x", "y"], 0) == []


def test_negative_k_raises():
    with pytest.raises(ValueError):
        top_k_frequent(["x"], -1)


def test_empty_items():
    assert top_k_frequent([], 3) == []


def test_non_string_hashables():
    assert top_k_frequent([3, 1, 3, (1, 2), (1, 2), (1, 2)], 2) == [(1, 2), 3]


def test_input_not_modified():
    items = ["b", "a", "b"]
    top_k_frequent(items, 1)
    assert items == ["b", "a", "b"]
