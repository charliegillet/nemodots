import pytest

from solution import LRUCache


def test_put_and_get():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("a") == 1
    assert c.get("b") == 2


def test_get_missing_returns_default():
    c = LRUCache(2)
    assert c.get("x") is None
    assert c.get("x", 42) == 42


def test_evicts_least_recently_used_when_full():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.put("c", 3)
    assert "a" not in c
    assert c.get("b") == 2 and c.get("c") == 3
    assert len(c) == 2


def test_get_refreshes_recency():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.get("a")
    c.put("c", 3)
    assert "b" not in c
    assert "a" in c and "c" in c


def test_put_existing_key_refreshes_recency_and_updates_value():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.put("a", 10)
    c.put("c", 3)
    assert "b" not in c
    assert c.get("a") == 10


def test_put_existing_key_does_not_evict():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.put("b", 20)
    assert len(c) == 2
    assert c.keys() == ["a", "b"]
    assert c.get("a") == 1 and c.get("b") == 20


def test_capacity_zero_stores_nothing():
    c = LRUCache(0)
    c.put("a", 1)
    assert len(c) == 0
    assert "a" not in c
    assert c.get("a") is None
    assert c.keys() == []


def test_negative_capacity_raises():
    with pytest.raises(ValueError):
        LRUCache(-1)


def test_contains_and_len_do_not_refresh_recency():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert "a" in c
    assert len(c) == 2
    c.put("c", 3)
    assert "a" not in c
    assert c.keys() == ["b", "c"]


def test_keys_are_ordered_least_to_most_recent():
    c = LRUCache(3)
    c.put("a", 1)
    c.put("b", 2)
    c.put("c", 3)
    c.get("a")
    c.put("b", 22)
    assert c.keys() == ["c", "a", "b"]
    keys = c.keys()
    keys.append("zzz")
    assert c.keys() == ["c", "a", "b"]


def test_keys_does_not_change_recency():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.keys()
    c.put("c", 3)
    assert c.keys() == ["b", "c"]


def test_none_values_are_stored():
    c = LRUCache(2)
    c.put("a", None)
    assert "a" in c
    assert c.get("a", "default") is None
    assert len(c) == 1


def test_miss_does_not_change_order():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("zzz") is None
    c.put("c", 3)
    assert c.keys() == ["b", "c"]


def test_capacity_one():
    c = LRUCache(1)
    c.put("a", 1)
    c.put("b", 2)
    assert c.keys() == ["b"]
    c.put("b", 3)
    assert c.get("b") == 3
    assert len(c) == 1
