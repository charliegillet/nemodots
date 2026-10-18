class LRUCache:
    """A fixed-capacity least-recently-used cache."""

    def __init__(self, capacity: int) -> None:
        """Create an empty cache holding at most `capacity` entries."""
        raise NotImplementedError

    def get(self, key, default=None):
        """Return the value for `key` (marking it most recently used) or `default`."""
        raise NotImplementedError

    def put(self, key, value) -> None:
        """Insert or update `key`, evicting the least recently used entry if needed."""
        raise NotImplementedError

    def keys(self) -> list:
        """Return the keys from least to most recently used."""
        raise NotImplementedError

    def __len__(self) -> int:
        """Return the number of entries."""
        raise NotImplementedError

    def __contains__(self, key) -> bool:
        """Return True if `key` is present (does not change recency)."""
        raise NotImplementedError
