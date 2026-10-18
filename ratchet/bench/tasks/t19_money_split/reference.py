def split_amount(total_cents: int, n: int) -> list[int]:
    """Split integer cents into n parts that differ by at most one cent."""
    if n < 1:
        raise ValueError("n must be at least 1")
    sign = -1 if total_cents < 0 else 1
    base, extra = divmod(abs(total_cents), n)
    return [sign * (base + 1 if i < extra else base) for i in range(n)]


def allocate(total_cents: int, weights: list[int]) -> list[int]:
    """Split integer cents proportionally to weights (largest remainder method)."""
    if not weights or any(w < 0 for w in weights) or sum(weights) <= 0:
        raise ValueError("weights must be non-negative with a positive sum")
    sign = -1 if total_cents < 0 else 1
    total = abs(total_cents)
    weight_sum = sum(weights)
    parts = [total * w // weight_sum for w in weights]
    remainders = [total * w % weight_sum for w in weights]
    missing = total - sum(parts)
    order = sorted(range(len(weights)), key=lambda i: (-remainders[i], i))
    for i in order[:missing]:
        parts[i] += 1
    return [sign * p for p in parts]
