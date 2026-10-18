# Acceptance statement

The incident is resolved when all of the following hold after the repair:

- a fresh order can be created and read back successfully;
- the inventory invariant holds (stock decreased by exactly what was ordered, never below zero, and the API view agrees with the authority);
- health stays ok over a short observation window.

An independent probe checks this after the team finishes. A claim that something is fixed is not acceptance; only fresh readings made after the repair count as evidence that it worked. Verify with new observations, and cite their receipts.
