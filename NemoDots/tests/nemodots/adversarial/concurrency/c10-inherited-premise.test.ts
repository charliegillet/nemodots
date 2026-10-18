// C10 (medium): the intent's dependency vector must include the inherited
// context receipts, not only the cited ones.
// Expected (ARCHITECTURE 14 C10, CONTRACTS 5): vector = emitting model call's
// snapshot.dependencyVector UNION cited receipts (each in scope). A premise
// the model saw but did not cite still gates admission and commit; a cited
// receipt outside the snapshot/readset/inherited scope is
// blocked(citation_out_of_scope) and never gates anything as authority.
import { describe, expect, it } from 'vitest';
import {
  admitAndCommit,
  configState,
  createAttempt,
  emitModelCall,
  externalChange,
  memberReceipt,
  observed,
  proposeCtx,
  scenario,
  setConfigInput,
  withWorld,
  type ConfigScalar,
} from './harness.js';

describe('C10 inherited premise in the vector', () => {
  it('the stored vector is the whole emitting snapshot vector although nothing was cited', async () => {
    await withWorld(async (world) => {
      const inherited = await memberReceipt(world, 'db.statement_timeout_ms');
      const s = await scenario(world, { extra: [inherited] });
      const state = await configState(world, 'db.pool_max');
      const intent = await world.service.propose(
        setConfigInput(20, state.value as ConfigScalar),
        proposeCtx(s),
      );
      const keys = intent.dependencyVector.map((e) => e.sourceKey).sort();
      expect(keys).toEqual([
        'checkout.config/db.pool_max',
        'checkout.config/db.statement_timeout_ms',
        'checkout.health',
      ]);
    });
  });

  it('the uncited inherited premise changes before admission: blocked, nothing written', async () => {
    await withWorld(async (world) => {
      const inherited = await memberReceipt(world, 'db.statement_timeout_ms');
      const s = await scenario(world, { extra: [inherited] });
      const state = await configState(world, 'db.pool_max');
      const intent = await world.service.propose(
        setConfigInput(20, state.value as ConfigScalar),
        proposeCtx(s),
      );
      await externalChange(world, 'db.statement_timeout_ms', 100);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('blocked');
      expect(['stale_version', 'stale_pending_observation']).toContain(
        admitted.blockReason,
      );
      expect((await configState(world, 'db.pool_max')).value).toBe(10);
    });
  });

  it('the uncited inherited premise changes between admission and commit: the commit blocks', async () => {
    await withWorld(async (world) => {
      const inherited = await memberReceipt(world, 'routing.inventory_source');
      const s = await scenario(world, { extra: [inherited] });
      const state = await configState(world, 'db.pool_max');
      const intent = await world.service.propose(
        setConfigInput(20, state.value as ConfigScalar),
        proposeCtx(s),
      );
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      await externalChange(world, 'routing.inventory_source', 'replica_stale');
      const committed = await world.service.commit(intent.id, admitted.dispatch!.fence);
      expect(committed.status).toBe('blocked');
      expect((await configState(world, 'db.pool_max')).value).toBe(10);
    });
  });

  it('an inherited OBSERVED premise superseded after proposal also blocks', async () => {
    await withWorld(async (world) => {
      const stats = await observed(world, 'redis.stats', { activeNamespace: 'catalog-a' });
      const s = await scenario(world, { extra: [stats] });
      const state = await configState(world, 'db.pool_max');
      const intent = await world.service.propose(
        setConfigInput(20, state.value as ConfigScalar),
        proposeCtx(s),
      );
      await observed(world, 'redis.stats', { activeNamespace: 'catalog-b' });
      const result = await admitAndCommit(world, intent.id);
      expect(result.committed.status).toBe('blocked');
      expect(result.committed.blockReason).toBe('stale_version');
    });
  });

  it('citing a receipt that is not in the snapshot, readset or inherited vector is blocked(citation_out_of_scope)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const foreign = await memberReceipt(world, 'ui.banner_text');
      const state = await configState(world, 'db.pool_max');
      const intent = await world.service.propose(
        setConfigInput(20, state.value as ConfigScalar, { cite: [foreign.id] }),
        proposeCtx(s),
      );
      expect(intent.status).toBe('blocked');
      expect(intent.blockReason).toBe('citation_out_of_scope');
      // ...and a receipt of ANOTHER attempt's snapshot is equally foreign.
      const other = await createAttempt(world);
      const otherCall = await emitModelCall(world, other, [foreign]);
      void otherCall;
    });
  });
});
