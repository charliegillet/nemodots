import copy

import pytest

from solution import spiral_order


def test_square_3x3():
    assert spiral_order([[1, 2, 3], [4, 5, 6], [7, 8, 9]]) == [1, 2, 3, 6, 9, 8, 7, 4, 5]


def test_square_4x4():
    m = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]
    assert spiral_order(m) == [1, 2, 3, 4, 8, 12, 16, 15, 14, 13, 9, 5, 6, 7, 11, 10]


def test_wide_3x4():
    m = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]
    assert spiral_order(m) == [1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7]


def test_tall_4x3():
    m = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]
    assert spiral_order(m) == [1, 2, 3, 6, 9, 12, 11, 10, 7, 4, 5, 8]


def test_wide_2x5_has_no_duplicates():
    m = [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]
    assert spiral_order(m) == [1, 2, 3, 4, 5, 10, 9, 8, 7, 6]


def test_tall_5x2_has_no_duplicates():
    m = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]
    assert spiral_order(m) == [1, 2, 4, 6, 8, 10, 9, 7, 5, 3]


def test_single_row():
    assert spiral_order([[1, 2, 3]]) == [1, 2, 3]


def test_single_column():
    assert spiral_order([[1], [2], [3]]) == [1, 2, 3]


def test_one_by_one_and_two_by_two():
    assert spiral_order([[7]]) == [7]
    assert spiral_order([[1, 2], [3, 4]]) == [1, 2, 4, 3]


def test_empty_matrices():
    assert spiral_order([]) == []
    assert spiral_order([[]]) == []
    assert spiral_order([[], []]) == []


def test_ragged_rows_raise():
    with pytest.raises(ValueError):
        spiral_order([[1, 2], [3]])
    with pytest.raises(ValueError):
        spiral_order([[1], [2, 3]])


def test_values_of_any_type_and_input_unchanged():
    m = [["a", "b"], ["c", None]]
    before = copy.deepcopy(m)
    assert spiral_order(m) == ["a", "b", None, "c"]
    assert m == before


def test_every_element_exactly_once_for_many_shapes():
    for rows in range(1, 7):
        for cols in range(1, 7):
            m = [[r * cols + c for c in range(cols)] for r in range(rows)]
            result = spiral_order(m)
            assert sorted(result) == list(range(rows * cols))
            assert result[:cols] == list(range(cols))
