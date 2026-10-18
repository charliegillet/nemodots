// Schema names the ledger reads. Defaults are the production schemas; tests
// that must not depend on another package's migration point them at fixture
// schemas. Names are validated as plain identifiers before they are
// interpolated into SQL.
import type { EventSinkPort } from '../contracts/index.js';
import { LedgerError } from './errors.js';

export interface LedgerOptions {
  /** Schema holding config_entries / config_collection (default 'checkout'). */
  checkoutSchema?: string;
  /** Schema holding task_attempts / task_outputs / action_intents / tasks (default 'coordinator'). */
  coordinatorSchema?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export function identifier(name: string): string {
  if (!IDENTIFIER.test(name))
    throw new LedgerError('unsafe_identifier', `unsafe schema name "${name}"`);
  return name;
}

export function checkoutSchema(options?: LedgerOptions): string {
  return identifier(options?.checkoutSchema ?? 'checkout');
}

export function coordinatorSchema(options?: LedgerOptions): string {
  return identifier(options?.coordinatorSchema ?? 'coordinator');
}

/**
 * Options of every function that can supersede or retire a receipt
 * (registerObservation, registerWithoutClosure, transitionReceipt, the
 * closure engine). `events` is the EventSinkPort used to emit one coordinator
 * `invalidation.recorded` event per affected mission INSIDE the registration
 * transaction (ARCHITECTURE 5.2 step 5, finding I10). It is required so that a
 * forgotten wire is a compile error, not a silently dropped event; the
 * coordinator's sink takes the C6 advisory lock right before each INSERT.
 */
export interface RegistrationLedgerOptions extends LedgerOptions {
  events: EventSinkPort;
}

export function requireEventSink(
  options: LedgerOptions | undefined,
): RegistrationLedgerOptions {
  const events = (options as { events?: EventSinkPort } | undefined)?.events;
  if (!events || typeof events.append !== 'function')
    throw new LedgerError(
      'event_sink_missing',
      'registration needs ledger.events (an EventSinkPort); invalidation events would be dropped',
    );
  return options as RegistrationLedgerOptions;
}
