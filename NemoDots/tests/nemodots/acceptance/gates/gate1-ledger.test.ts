// Gate 1 (ledger and lineage), THE single runner (docs/nemodots/ACCEPTANCE_CONTRACT.md section 3).
//
// It delegates to the executable suites in ../g1-ledger/*.suite.ts, which drive the real production modules on
// real PostgreSQL and carry the frozen oracle's LEDGER_CASES, CLOSURE_CASES and REJECTION_CASES plus the
// TEST_PROMPT gate-1 attack tests (items 1-13, each titled [G1.n]):
//
//   ledger-cases   LG-01..LG-16 (registration, supersession, freshness, real page edit)
//   closure        CL-1..CL-9 (closure rows, per-mission subsets, R5 events), RJ-5..RJ-7 (edge and cap rejections)
//   publication    G2 publication path: findings, handoffs, child enqueues, model-call records, plans, delegation
//                  (items 2, 7, 8, 13, RJ-1..RJ-4)
//   integrity      immutability, scope isolation, ABA/C8 races, trust, locks (items 1-5, 10-13)
//   context-lineage context compilation lineage and stale re-entry (items 6, 7)
//   coverage       every TEST_PROMPT item and oracle case is named and executed
//
// The suite files are *.suite.ts so Vitest does not also run them as separate files: one gate, one runner.
// A missing production entry point FAILS the affected tests with "ENTRY POINT MISSING"; nothing is skipped.
import '../g1-ledger/ledger-cases.suite.js';
import '../g1-ledger/closure.suite.js';
import '../g1-ledger/publication.suite.js';
import '../g1-ledger/integrity.suite.js';
import '../g1-ledger/context-lineage.suite.js';
import '../g1-ledger/coverage.suite.js';
