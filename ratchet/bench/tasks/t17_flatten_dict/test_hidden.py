import copy

import pytest

from solution import flatten


def test_flat_dict_unchanged():
    assert flatten({"a": 1, "b": 2}) == {"a": 1, "b": 2}


def test_nested_dicts_are_joined_with_dots():
    data = {"a": {"b": 1, "c": {"d": 2}}, "e": 3}
    assert flatten(data) == {"a.b": 1, "a.c.d": 2, "e": 3}


def test_custom_separators():
    assert flatten({"a": {"b": {"c": 1}}}, sep="/") == {"a/b/c": 1}
    assert flatten({"a": {"b": 1}}, sep="__") == {"a__b": 1}


def test_lists_and_tuples_are_not_flattened():
    data = {"a": [{"b": 1}], "t": ({"x": 1},), "n": {"l": [1, 2]}}
    assert flatten(data) == {"a": [{"b": 1}], "t": ({"x": 1},), "n.l": [1, 2]}


def test_empty_nested_dict_is_kept():
    assert flatten({"a": {}, "b": {"c": {}}}) == {"a": {}, "b.c": {}}


def test_empty_input():
    assert flatten({}) == {}


def test_non_string_keys_are_stringified():
    assert flatten({1: {2: "x"}, None: {True: 0}}) == {"1.2": "x", "None.True": 0}


def test_falsy_values_are_kept():
    data = {"a": {"none": None, "zero": 0, "empty": "", "false": False}}
    assert flatten(data) == {"a.none": None, "a.zero": 0, "a.empty": "", "a.false": False}


def test_collision_raises_value_error():
    with pytest.raises(ValueError):
        flatten({"a.b": 1, "a": {"b": 2}})
    with pytest.raises(ValueError):
        flatten({"a": {"b": 2}, "a.b": 1})


def test_depth_first_insertion_order():
    data = {"z": {"y": 1, "x": {"w": 2}}, "a": 3, "m": {"n": 4}}
    assert list(flatten(data)) == ["z.y", "z.x.w", "a", "m.n"]


def test_input_is_not_modified():
    data = {"a": {"b": {"c": [1, {"d": 2}]}}, "e": {}}
    before = copy.deepcopy(data)
    flatten(data)
    assert data == before


def test_deep_nesting():
    data = current = {}
    for i in range(30):
        current[f"k{i}"] = {}
        current = current[f"k{i}"]
    current["leaf"] = "v"
    key = ".".join(f"k{i}" for i in range(30)) + ".leaf"
    assert flatten(data) == {key: "v"}
