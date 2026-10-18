from collections import OrderedDict


class LRUCache:
    """A fixed-capacity least-recently-used cache."""

    def __init__(self, capacity: int) -> None:
        """Create an empty cache holding at most `capacity` entries."""
        if capacity < 0:
            raise ValueError("capacity must be >= 0")
        self.capacity = capacity
        self._data: OrderedDict = OrderedDict()

    def get(self, key, default=None):
        """Return the value for `key` (marking it most recently used) or `default`."""
        if key not in self._data:
            return default
        self._data.move_to_end(key)
        return self._data[key]

    def put(self, key, value) -> None:
        """Insert or update `key`, evicting the least recently used entry if needed."""
        if self.capacity == 0:
            return
        if key in self._data:
            self._data.move_to_end(key)
            self._data[key] = value
            return
        if len(self._data) >= self.capacity:
            self._data.popitem(last=False)
        self._data[key] = value

    def keys(self) -> list:
        """Return the keys from least to most recently used."""
        return list(self._data)

    def __len__(self) -> int:
        """Return the number of entries."""
        return len(self._data)

    def __contains__(self, key) -> bool:
        """Return True if `key` is present (does not change recency)."""
        return key in self._data
