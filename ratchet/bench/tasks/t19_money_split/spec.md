# Split money fairly

An expense-sharing app splits bills between people. Amounts are integers in cents and every cent
must be accounted for: the parts always add up exactly to the total.

## Functions

```python
def split_amount(total_cents: int, n: int) -> list[int]
def allocate(total_cents: int, weights: list[int]) -> list[int]
```

## Rules

`split_amount(total_cents, n)` splits into `n` equal-as-possible parts:

- `n` must be at least 1, otherwise raise `ValueError`.
- Parts differ by at most one cent and sum to `total_cents`. The leftover cents go to the **first**
  parties: `split_amount(1000, 3)` is `[334, 333, 333]`.
- Negative totals (refunds) are split by magnitude and then negated, so the first parties get the
  larger magnitude: `split_amount(-1000, 3)` is `[-334, -333, -333]`.
- A total of 0 gives `n` zeros.

`allocate(total_cents, weights)` splits proportionally to integer weights:

- `weights` must be a non-empty list of non-negative integers with a positive sum, otherwise raise
  `ValueError`.
- Work with the magnitude `t = abs(total_cents)`. Party `i` first gets `floor(t * w_i / W)` cents, where
  `W` is the sum of the weights. The cents still missing (`t` minus the sum of those floors) are then
  given out one each, to the parties with the **largest remainders** `(t * w_i) mod W`; equal
  remainders favour the earlier party. Finally, if `total_cents` is negative, negate every part.
- Use exact integer arithmetic. The result always sums to `total_cents`; a party with weight 0 gets 0.

## Examples

```python
>>> split_amount(1000, 3)
[334, 333, 333]
>>> split_amount(-10, 4)
[-3, -3, -2, -2]
>>> allocate(100, [1, 2])
[33, 67]
>>> allocate(5, [3, 7])
[2, 3]
>>> allocate(10, [0, 1, 0])
[0, 10, 0]
```
