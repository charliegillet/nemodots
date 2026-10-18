import copy

import pytest

from solution import merge_intervals


def test_basic_overlaps_merge():
    assert merge_intervals([(1, 3), (2, 6), (8, 10), (15, 18)]) == [(1, 6), (8, 10), (15, 18)]


def test_unsorted_input_is_handled():
    assert merge_intervals([(8, 10), (1, 3), (2, 6)]) == [(1, 6), (8, 10)]
    assert merge_intervals([(5, 6), (1, 2), (3, 4)]) == [(1, 2), (3, 4), (5, 6)]


def test_touching_intervals_merge():
    assert merge_intervals([(1, 2), (2, 3)]) == [(1, 3)]
    assert merge_intervals([(2, 3), (1, 2), (3, 4)]) == [(1, 4)]


def test_nearly_touching_intervals_stay_separate():
    assert merge_intervals([(1, 2), (2.5, 3)]) == [(1, 2), (2.5, 3)]


def test_merges_into_the_latest_interval_not_the_first():
    assert merge_intervals([(1, 2), (5, 7), (6, 9)]) == [(1, 2), (5, 9)]
    assert merge_intervals([(0, 1), (3, 4), (4, 6), (5, 5), (10, 11)]) == [(0, 1), (3, 6), (10, 11)]


def test_nested_interval_is_absorbed_and_end_never_shrinks():
    assert merge_intervals([(1, 10), (2, 3), (4, 5)]) == [(1, 10)]
    assert merge_intervals([(1, 10), (2, 3), (9, 12)]) == [(1, 12)]


def test_float_bounds():
    assert merge_intervals([(0.5, 1.5), (1.25, 2.0)]) == [(0.5, 2.0)]
    assert merge_intervals([(0.1, 0.2), (0.3, 0.4)]) == [(0.1, 0.2), (0.3, 0.4)]


def test_negative_numbers():
    assert merge_intervals([(-5, -1), (-2, 0)]) == [(-5, 0)]


def test_empty_and_single():
    assert merge_intervals([]) == []
    assert merge_intervals([(5, 7)]) == [(5, 7)]


def test_zero_length_intervals():
    assert merge_intervals([(3, 3), (3, 5)]) == [(3, 5)]
    assert merge_intervals([(1, 1), (2, 2)]) == [(1, 1), (2, 2)]


def test_duplicates_collapse():
    assert merge_intervals([(1, 3), (1, 3), (1, 3)]) == [(1, 3)]


def test_same_start_keeps_longest_end():
    assert merge_intervals([(1, 5), (1, 2)]) == [(1, 5)]


def test_start_after_end_raises():
    with pytest.raises(ValueError):
        merge_intervals([(1, 3), (5, 4)])


def test_lists_accepted_and_tuples_returned():
    result = merge_intervals([[1, 3], [2, 4]])
    assert result == [(1, 4)]
    assert all(type(iv) is tuple for iv in result)


def test_input_is_not_modified():
    data = [(8, 10), (1, 3), (2, 6)]
    before = copy.deepcopy(data)
    merge_intervals(data)
    assert data == before
