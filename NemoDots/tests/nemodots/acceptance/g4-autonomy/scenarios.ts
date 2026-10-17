// Scripted provider behaviours. They stand in for a (possibly adversarial)
// model so that server-side enforcement can be checked deterministically.
// Task routing keys on a marker the plan puts in the task title/question.
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
export function toolMessageTexts(call: ProviderCall): string[] {
  return call.toolMessages.map((m) =>
    typeof m === 'string' ? m : JSON.stringify(m),
  );
}

export const SPECIALIST_CAPS = {
  cache_specialist: [
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
    'propose_cache_flush',
  ],
  routing_specialist: [
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
  ],
  database_specialist: [
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
  ],
  investigator: ['observe', 'delegate', 'publish_finding', 'request_replan'],
  verifier: ['observe', 'publish_finding'],
} as const;

export interface PlanTaskSpec {
  title: string;
  question: string;
  role: keyof typeof SPECIALIST_CAPS;
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
        capabilities: [...SPECIALIST_CAPS[t.role]],
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
