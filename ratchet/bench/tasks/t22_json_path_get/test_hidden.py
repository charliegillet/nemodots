import pytest

from solution import get_path

DATA = {
    "servers": [{"host": "a", "ports": [80, 443]}, {"host": "b", "tags": None}],
    "meta": {"owner": {"name": "ops"}, "0": "zero-key"},
    "matrix": [[1, 2], [3, 4]],
    "pair": (10, 20),
    "text": "xyz",
    "count": 5,
}


def test_nested_keys():
    assert get_path(DATA, "meta.owner.name") == "ops"


def test_keys_and_indexes():
    assert get_path(DATA, "servers[0].host") == "a"
    assert get_path(DATA, "servers[0].ports[1]") == 443


def test_negative_indexes():
    assert get_path(DATA, "servers[-1].host") == "b"
    assert get_path(DATA, "servers[0].ports[-2]") == 80


def test_consecutive_indexes_and_leading_index():
    assert get_path(DATA, "matrix[1][0]") == 3
    assert get_path([{"name": "first"}], "[0].name") == "first"
    assert get_path([[5]], "[0][0]") == 5


def test_empty_path_returns_data_itself():
    assert get_path(DATA, "") is DATA


def test_missing_key_returns_default():
    assert get_path(DATA, "meta.missing") is None
    assert get_path(DATA, "meta.missing", default="d") == "d"
    assert get_path(DATA, "nope.deeper", default=0) == 0


def test_index_out_of_range_returns_default():
    assert get_path(DATA, "servers[2]", default="d") == "d"
    assert get_path(DATA, "servers[-3]", default="d") == "d"


def test_digit_key_step_is_a_key_not_an_index():
    assert get_path(DATA, "meta.0") == "zero-key"
    assert get_path(DATA, "servers.0", default="d") == "d"


def test_index_step_on_dict_or_string_returns_default():
    assert get_path(DATA, "meta[0]", default="d") == "d"
    assert get_path(DATA, "text[0]", default="d") == "d"


def test_step_on_scalar_or_none_returns_default():
    assert get_path(DATA, "count.value", default="d") == "d"
    assert get_path(DATA, "count[0]", default="d") == "d"
    assert get_path(DATA, "servers[1].tags.first", default="d") == "d"
    assert get_path(None, "a", default="d") == "d"


def test_present_none_is_returned_not_default():
    assert get_path(DATA, "servers[1].tags", default="d") is None


def test_tuples_are_indexable():
    assert get_path(DATA, "pair[1]") == 20
    assert get_path(DATA, "pair[-1]") == 20


def test_keys_may_contain_spaces_and_dashes():
    assert get_path({"a b": {"c-d": 1}}, "a b.c-d") == 1


def test_malformed_paths_raise():
    for path in ["a..b", "a.", ".a", "a[x]", "a[", "a[]", "a]", "a[0]b", "a[1.5]", "[", "a[-]", "a.[0]",
                 "a[+1]", "a[ 1]", "a[1_0]", "[12", "a[12", "a[0]bc", "a]bc"]:
        with pytest.raises(ValueError):
            get_path(DATA, path)


def test_malformed_path_raises_even_when_data_is_missing():
    with pytest.raises(ValueError):
        get_path({}, "missing..x")
    with pytest.raises(ValueError):
        get_path(None, "a[")
