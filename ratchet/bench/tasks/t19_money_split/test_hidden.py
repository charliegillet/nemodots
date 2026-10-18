import pytest

from solution import allocate, split_amount


def test_split_even():
    assert split_amount(900, 3) == [300, 300, 300]


def test_split_leftover_cents_go_to_first_parties():
    assert split_amount(1000, 3) == [334, 333, 333]
    assert split_amount(101, 4) == [26, 25, 25, 25]
    assert split_amount(103, 4) == [26, 26, 26, 25]


def test_split_more_parties_than_cents():
    assert split_amount(2, 5) == [1, 1, 0, 0, 0]


def test_split_single_party_and_zero_total():
    assert split_amount(1234, 1) == [1234]
    assert split_amount(0, 3) == [0, 0, 0]


def test_split_negative_total_mirrors_positive():
    assert split_amount(-1000, 3) == [-334, -333, -333]
    assert split_amount(-2, 5) == [-1, -1, 0, 0, 0]
    assert split_amount(-10, 4) == [-3, -3, -2, -2]
    assert split_amount(-1, 2) == [-1, 0]


def test_split_invalid_n_raises():
    for n in [0, -1]:
        with pytest.raises(ValueError):
            split_amount(100, n)


def test_split_always_sums_and_differs_by_at_most_one():
    for total in range(-50, 51, 7):
        for n in range(1, 9):
            parts = split_amount(total, n)
            assert len(parts) == n
            assert sum(parts) == total
            assert max(parts) - min(parts) <= 1


def test_allocate_equal_weights():
    assert allocate(100, [1, 1, 1]) == [34, 33, 33]


def test_allocate_largest_remainder_not_first_party():
    assert allocate(100, [1, 2]) == [33, 67]
    assert allocate(10, [3, 4]) == [4, 6]
    assert allocate(10, [1, 1, 4]) == [2, 2, 6]


def test_allocate_equal_remainders_favour_earlier_party():
    assert allocate(5, [3, 7]) == [2, 3]
    assert allocate(1, [1, 1]) == [1, 0]


def test_allocate_zero_weight_gets_nothing():
    assert allocate(10, [0, 1, 0]) == [0, 10, 0]
    assert allocate(7, [0, 1, 1]) == [0, 4, 3]


def test_allocate_negative_total_mirrors_positive():
    assert allocate(-100, [1, 2]) == [-33, -67]
    assert allocate(-5, [3, 7]) == [-2, -3]
    assert allocate(-1, [1, 1]) == [-1, 0]


def test_allocate_invalid_weights_raise():
    for weights in [[], [0, 0], [-1, 2], [1, -1, 3]]:
        with pytest.raises(ValueError):
            allocate(100, weights)


def test_allocate_exact_for_large_amounts():
    assert allocate(10 ** 18 + 1, [1, 1]) == [5 * 10 ** 17 + 1, 5 * 10 ** 17]
    assert allocate(10 ** 17, [1, 2]) == [33333333333333333, 66666666666666667]


def test_allocate_always_sums_to_total():
    for total in [-1001, -7, 0, 1, 99, 1000, 123457]:
        for weights in [[1], [1, 1], [2, 3, 5], [7, 0, 13], [1, 1, 1, 1, 1, 1, 1]]:
            parts = allocate(total, weights)
            assert sum(parts) == total
            assert len(parts) == len(weights)
