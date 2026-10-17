// Scripted provider behaviours. They stand in for a (possibly adversarial)
// model so that server-side enforcement can be checked deterministically.
// Task routing keys on a marker the plan puts in the task title/question.
import { SPEC_ROLE_CAPABILITIES } from './spec.js';
import type {
  ProviderCall,
  ProviderReply,
  ProviderScript,
} from './provider.js';

const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

export function uuidsIn(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [...new Set(text.match(UUID) ?? [])];
}
/** The receipt id in the most recent tool result (observe_source returns it). */
export function lastReceiptId(call: ProviderCall): string | null {
  const last = call.toolMessages.at(-1);
  return last === undefined ? null : (uuidsIn(last)[0] ?? null);
}
/** The receipt id in the i-th tool result of the conversation (0-based), or null. */
export function receiptIdAt(call: ProviderCall, index: number): string | null {
  const message = call.toolMessages[index];
  return message === undefined ? null : (uuidsIn(message)[0] ?? null);
}
export function toolMessageTexts(call: ProviderCall): string[] {
  return call.toolMessages.map((m) =>
    typeof m === 'string' ? m : JSON.stringify(m),
  );
}

export const SPECIALIST_CAPS = SPEC_ROLE_CAPABILITIES;

export interface PlanTaskSpec {
  title: string;
  question: string;
  role: Exclude<keyof typeof SPEC_ROLE_CAPABILITIES, 'planner' | 'postcondition'>;
  dependsOn?: number[];
}
export function planReply(tasks: PlanTaskSpec[]): ProviderReply {
  return {
    type: 'content',
    text: JSON.stringify({
      tasks: tasks.map((t) => ({
        title: t.title,
        question: t.question,
        role: t.role,
        capabilities: [...SPEC_ROLE_CAPABILITIES[t.role]],
        dependsOn: t.dependsOn ?? [],
      })),
    }),
  };
}

/** Two independent branches and a verifier that inherits the first branch. */
export const ALPHA = 'ALPHA-cache-branch';
export const BRAVO = 'BRAVO-routing-branch';
export const CHARLIE = 'CHARLIE-verification';
export const TWO_BRANCH_PLAN: PlanTaskSpec[] = [
  {
    title: ALPHA,
    question: `${ALPHA}: examine the cache schema configuration and report.`,
    role: 'cache_specialist',
  },
  {
    title: BRAVO,
    question: `${BRAVO}: examine the order write flag and report.`,
    role: 'routing_specialist',
  },
  {
    title: CHARLIE,
    question: `${CHARLIE}: verify the cache branch result.`,
    role: 'verifier',
    dependsOn: [0],
  },
];

export const ALPHA_SOURCE = 'checkout.config/cache.schema_version';
export const BRAVO_SOURCE = 'checkout.config/orders.write_enabled';

const done = (text: string): ProviderReply => ({ type: 'content', text });
const observe = (sourceKey: string): ProviderReply => ({
  type: 'tool_calls',
  calls: [{ name: 'observe_source', args: { sourceKey } }],
});
const finding = (claim: string, receiptId: string | null): ProviderReply => ({
  type: 'tool_calls',
  calls: [
    {
      name: 'publish_finding',
      args: {
        claim,
        supportingReceiptIds: receiptId ? [receiptId] : [],
        confidence: 'medium',
      },
    },
  ],
});

/** observe -> publish_finding citing it -> finish. Used for every branch. */
export function observeThenReport(marker: string, source: string) {
  return (call: ProviderCall): ProviderReply | null => {
    if (!call.text.includes(marker)) return null;
    if (call.toolResults === 0) return observe(source);
    if (call.toolResults === 1)
      return finding(`${marker} observed ${source}.`, lastReceiptId(call));
    return done(`${marker} complete.`);
  };
}

export function compose(
  planner: ProviderReply,
  ...handlers: ((
    call: ProviderCall,
  ) => ProviderReply | null | Promise<ProviderReply | null>)[]
): ProviderScript {
  return async (call) => {
    if (call.kind === 'structured') return planner;
    for (const handler of handlers) {
      const reply = await handler(call);
      if (reply) return reply;
    }
    return done('no scripted behaviour for this call');
  };
}

// CHARLIE first: its inherited context quotes the ALPHA output, so ALPHA's
// marker also appears in CHARLIE's request. CHARLIE's marker appears nowhere else.
export const twoBranchHandlers = [
  observeThenReport(CHARLIE, 'checkout.health'),
  observeThenReport(BRAVO, BRAVO_SOURCE),
  observeThenReport(ALPHA, ALPHA_SOURCE),
];

export const observeCall = (sourceKey: string): ProviderReply => ({
  type: 'tool_calls',
  calls: [{ name: 'observe_source', args: { sourceKey } }],
});

export interface ProposerState {
  /** The value ALPHA proposes for cache.schema_version. */
  value: string | number | boolean;
  /** Spec digest of the value currently in checkout.config_entries (read via the verifier role). */
  currentDigest: string;
  /** How many propose_action replies have been emitted. */
  proposals: number;
  /** Maximum proposals this scenario emits (default 1). */
  maxProposals: number;
  /** Number of attempts that started (a toolResults === 0 request). */
  starts: number;
  /** Rationale and marker text. */
  rationale: string;
}
export const newProposerState = (): ProposerState => ({
  value: 0,
  currentDigest: '0'.repeat(64),
  proposals: 0,
  maxProposals: 1,
  starts: 0,
  rationale: 'ALPHA proposes the schema version it observed to be wrong.',
});

/**
 * ALPHA's proposal, admissible by spec: it observes the target member and
 * checkout.health (policy-v1 requiredSources), cites both receipts, and binds
 * the digest of the value it read. Anything it ends up blocked for is
 * therefore caused by the system under test, not by this script.
 * Sequence: observe config, observe health, propose, publish finding, finish.
 * Later attempts (retry/repair) observe and report without proposing again.
 */
export function alphaProposer(
  state: ProposerState,
  config: { exclude?: string[] } = {},
) {
  return (call: ProviderCall): ProviderReply | null => {
    if (!call.text.includes(ALPHA)) return null;
    for (const marker of config.exclude ?? [CHARLIE])
      if (call.text.includes(marker)) return null;
    const n = call.toolResults;
    const names = call.toolCallNames;
    if (n === 0) {
      state.starts += 1;
      return observeCall(ALPHA_SOURCE);
    }
    if (n === 1)
      return state.proposals < state.maxProposals
        ? observeCall('checkout.health')
        : finding(
            `${ALPHA} re-read the schema version and reports it.`,
            receiptIdAt(call, 0),
          );
    if (n === 2 && names[1] === 'observe_source') {
      if (state.proposals >= state.maxProposals)
        return finding(`${ALPHA} reports.`, receiptIdAt(call, 0));
      state.proposals += 1;
      return {
        type: 'tool_calls',
        calls: [
          {
            name: 'propose_action',
            args: {
              action: 'set_config',
              payload: {
                key: 'cache.schema_version',
                value: state.value,
                expectedCurrentValueDigest: state.currentDigest,
              },
              supportingReceiptIds: [
                receiptIdAt(call, 0),
                receiptIdAt(call, 1),
              ].filter((id): id is string => Boolean(id)),
              rationale: state.rationale,
            },
          },
        ],
      };
    }
    if (n === 3 && names[2] === 'propose_action')
      return finding(
        `${ALPHA} reports the schema version it observed.`,
        receiptIdAt(call, 0),
      );
    return done(`${ALPHA} complete.`);
  };
}
