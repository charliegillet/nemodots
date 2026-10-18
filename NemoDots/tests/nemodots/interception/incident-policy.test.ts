// W5.3 repairs in the interception layer: TP-02 (a create that names no Space is
// refused for an incident Dot) and TP-15 (an empty approval vector is no
// evidence binding). The attacks through a real DotAgent turn and the
// approval route are in tests/nemodots/adversarial/tool-paths.
import { afterEach, describe, expect, it } from 'vitest';
import {
  INCIDENT_ENV,
  checkToolCall,
  createIncidentPolicy,
  withToolPolicy,
  type ToolPolicyScope,
  type VectorChecker,
} from '../../../src/server/nemodots/interception/index.js';
import { cleanup, entryFor } from './support.js';

afterEach(cleanup);

const env = { [INCIDENT_ENV]: 'dot' };
const scopeOf = (
  options: { projectionSpaceId?: string; dotId?: string } = {},
  defaultSpaceId: string | null = null,
): ToolPolicyScope => ({
  dotId: options.dotId ?? 'dot',
  policy: createIncidentPolicy({
    env,
    projectionSpaceId: options.projectionSpaceId,
  }),
  defaultSpaceId,
});

describe('create_space_page for an incident Dot (TP-02, M1)', () => {
  it('allows only an explicit projection Space', () => {
    const scope = scopeOf({ projectionSpaceId: 'projection' });
    expect(
      checkToolCall(scope, 'create_space_page', { spaceId: 'projection' }),
    ).toBeNull();
    expect(
      checkToolCall(scope, 'create_space_page', { spaceId: 'foreign' }),
    ).toMatchObject({ refused: true, row: 'M1', treatment: 'policy-checked' });
  });

  it('refuses a create that names no Space, whatever the default destination is', () => {
    // The Space an omitted spaceId lands in is the thread's page Space, else the
    // Dot's default (page-tools.ts resolve()); the check cannot know it, so it
    // must not assume the default.
    for (const defaultSpaceId of [null, 'projection', 'foreign']) {
      const scope = scopeOf(
        { projectionSpaceId: 'projection' },
        defaultSpaceId,
      );
      const refusal = checkToolCall(scope, 'create_space_page', {
        title: 'x',
        content: 'y',
      });
      expect(refusal, String(defaultSpaceId)).toMatchObject({
        refused: true,
        row: 'M1',
      });
      expect(refusal?.message).toMatch(/explicit spaceId/);
      expect(refusal?.message).toMatch(/incident scope/);
    }
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number', 7],
    ['an object', { id: 'projection' }],
    ['an array', ['projection']],
  ])('does not treat %s as the projection Space', (_label, spaceId) => {
    const scope = scopeOf({ projectionSpaceId: 'projection' }, 'projection');
    expect(
      checkToolCall(scope, 'create_space_page', { title: 'x', spaceId }),
    ).toMatchObject({ refused: true });
  });

  it('refuses malformed argument payloads instead of reading a Space from them', () => {
    const scope = scopeOf({ projectionSpaceId: 'projection' }, 'projection');
    for (const args of [undefined, null, 'projection', 3, []])
      expect(checkToolCall(scope, 'create_space_page', args)).toMatchObject({
        refused: true,
      });
  });

  it('refuses every create when no projection Space is configured, even an explicit one', () => {
    const scope = scopeOf({}, 'projection');
    expect(
      checkToolCall(scope, 'create_space_page', { spaceId: 'projection' }),
    ).toMatchObject({ refused: true });
    expect(checkToolCall(scope, 'create_space_page', {})).toMatchObject({
      refused: true,
    });
  });

  it('keeps refusing edits even into the projection Space', () => {
    const scope = scopeOf({ projectionSpaceId: 'projection' });
    expect(
      checkToolCall(scope, 'edit_space_page', { spaceId: 'projection' }),
    ).toMatchObject({ refused: true, row: 'M2' });
  });

  it('leaves ordinary Dots alone, with or without a Space', () => {
    const scope = scopeOf({ projectionSpaceId: 'projection', dotId: 'other' });
    expect(checkToolCall(scope, 'create_space_page', {})).toBeNull();
    expect(
      checkToolCall(scope, 'create_space_page', { spaceId: 'foreign' }),
    ).toBeNull();
  });

  it('refuses at execution too, before the executor is entered', () => {
    let ran = 0;
    const [create] = withToolPolicy(
      [{ name: 'create_space_page', execute: async () => ran++ }] as never[],
      scopeOf({ projectionSpaceId: 'projection' }, 'projection'),
    ) as { execute: (args: unknown) => unknown }[];
    expect(() => create.execute({ title: 'x' })).toThrow(/explicit spaceId/);
    expect(ran).toBe(0);
    create.execute({ title: 'x', spaceId: 'projection' });
    expect(ran).toBe(1);
  });
});

describe('revalidateApproval for an empty or missing vector (TP-15, M10)', () => {
  const approval = (
    dotId: string,
    dependencyVector: ReturnType<typeof entryFor>[] | null,
  ) => ({ threadId: 't', dotId, approvalId: 'a', dependencyVector });
  const checker = (current: boolean): VectorChecker => ({
    isCurrent: () => current,
  });

  it('refuses a NULL and an EMPTY vector for an incident Dot alike', async () => {
    const policy = createIncidentPolicy({ env, vectors: checker(true) });
    const [empty, missing] = await Promise.all([
      policy.revalidateApproval(approval('dot', [])),
      policy.revalidateApproval(approval('dot', null)),
    ]);
    expect(empty).toEqual(missing);
    expect(empty).toMatchObject({ ok: false });
    expect((empty as { reason: string }).reason).toMatch(/no evidence binding/);
  });

  it('refuses them whether or not a VectorChecker is installed', async () => {
    const policy = createIncidentPolicy({ env });
    expect(await policy.revalidateApproval(approval('dot', []))).toMatchObject({
      ok: false,
    });
  });

  it('passes both for an ordinary Dot (upstream behaviour is unchanged)', async () => {
    const policy = createIncidentPolicy({ env, vectors: checker(false) });
    expect(await policy.revalidateApproval(approval('other', []))).toEqual({
      ok: true,
    });
    expect(await policy.revalidateApproval(approval('other', null))).toEqual({
      ok: true,
    });
  });

  it('passes every approval when no Dot is listed', async () => {
    const policy = createIncidentPolicy({ env: {} });
    expect(await policy.revalidateApproval(approval('dot', []))).toEqual({
      ok: true,
    });
  });

  it('still checks a bound vector against current evidence', async () => {
    const bound = [entryFor('evidence', 2)];
    expect(
      await createIncidentPolicy({
        env,
        vectors: checker(true),
      }).revalidateApproval(approval('dot', bound)),
    ).toEqual({ ok: true });
    expect(
      await createIncidentPolicy({
        env,
        vectors: checker(false),
      }).revalidateApproval(approval('dot', bound)),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/superseded/) });
    expect(
      await createIncidentPolicy({ env }).revalidateApproval(
        approval('dot', bound),
      ),
    ).toMatchObject({ ok: false });
  });
});
