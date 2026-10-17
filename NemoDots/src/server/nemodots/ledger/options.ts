// Schema names the ledger reads. Defaults are the production schemas; tests
// that must not depend on another package's migration point them at fixture
// schemas. Names are validated as plain identifiers before they are
// interpolated into SQL.
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
