import math

import pytest

from solution import insert_position


class CountingSequence:
    """Sorted sequence that counts element reads and refuses iteration."""

    def __init__(self, n, descending=False):
        self.n = n
        self.descending = descending
        self.reads = 0

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        if not isinstance(i, int):
            raise TypeError("only integer indexes are supported")
        if i < 0 or i >= self.n:
            raise IndexError(i)
        self.reads += 1
        return (self.n - 1 - i) * 2 if self.descending else i * 2

    def __iter__(self):
        raise AssertionError("insert_position must not iterate over the sequence")


def test_basic_ascending():
    assert insert_position([1, 3, 5, 7], 4) == 2
    assert insert_position([1, 3, 5, 7], 4, side="right") == 2


def test_left_goes_before_duplicates():
    assert insert_position([1, 2, 2, 2, 3], 2) == 1


def test_right_goes_after_duplicates():
    assert insert_position([1, 2, 2, 2, 3], 2, side="right") == 4


def test_single_match_left_and_right():
    assert insert_position([1, 3, 5], 3) == 1
    assert insert_position([1, 3, 5], 3, side="right") == 2


def test_smaller_and_larger_than_everything():
    for side in ("left", "right"):
        assert insert_position([1, 3, 5], 0, side=side) == 0
        assert insert_position([1, 3, 5], 9, side=side) == 3


def test_empty_sequence():
    assert insert_position([], 10) == 0
    assert insert_position([], 10, side="right", descending=True) == 0


def test_all_equal_elements():
    assert insert_position([2, 2, 2], 2) == 0
    assert insert_position([2, 2, 2], 2, side="right") == 3
    assert insert_position([2, 2, 2], 2, descending=True) == 0
    assert insert_position([2, 2, 2], 2, side="right", descending=True) == 3


def test_descending_basic():
    assert insert_position([9, 7, 5, 3], 6, descending=True) == 2
    assert insert_position([9, 7, 5, 3], 10, descending=True) == 0
    assert insert_position([9, 7, 5, 3], 1, descending=True) == 4


def test_descending_duplicates():
    assert insert_position([5, 4, 4, 4, 1], 4, descending=True) == 1
    assert insert_position([5, 4, 4, 4, 1], 4, side="right", descending=True) == 4


def test_strings():
    assert insert_position(["a", "c", "e"], "b") == 1
    assert insert_position(["d", "c", "b", "a"], "bb", descending=True) == 2


def test_invalid_side_raises():
    with pytest.raises(ValueError):
        insert_position([1, 2], 1, side="middle")


def test_result_keeps_sequence_sorted():
    data = [0, 1, 1, 3, 3, 3, 8, 9]
    for x in range(-1, 11):
        for side in ("left", "right"):
            i = insert_position(data, x, side=side)
            merged = data[:i] + [x] + data[i:]
            assert merged == sorted(merged)
            rev = list(reversed(data))
            j = insert_position(rev, x, side=side, descending=True)
            merged = rev[:j] + [x] + rev[j:]
            assert merged == sorted(merged, reverse=True)


def test_uses_binary_search_on_large_sequences():
    n = 1_000_000
    limit = 2 * math.ceil(math.log2(n + 1)) + 2
    for x, expected_left in [(-5, 0), (1001, 501), (777778, 388889), (10 ** 9, n)]:
        seq = CountingSequence(n)
        assert insert_position(seq, x) == expected_left
        assert seq.reads <= limit


def test_binary_search_descending_and_right():
    n = 1_000_000
    limit = 2 * math.ceil(math.log2(n + 1)) + 2
    seq = CountingSequence(n, descending=True)
    # values are 2*(n-1), ..., 2, 0; the value 1000 sits at index n - 1 - 500
    assert insert_position(seq, 1000, side="right", descending=True) == n - 500
    assert seq.reads <= limit
