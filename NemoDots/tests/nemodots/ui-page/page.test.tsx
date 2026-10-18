import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../src/client/api', async () => {
  const { FakeApiError } = await import('./harness');
  return {
    api,
    ApiError: FakeApiError,
    authHeaders: () => ({ Authorization: 'Bearer test-token' }),
  };
});
const openPageLink = vi.hoisted(() => vi.fn());
vi.mock('../../../src/client/page-navigation', () => ({ openPageLink }));

import { MissionPage } from '../../../src/client/nemodots/MissionPage';
import {
  confirmation,
  eventPayloads,
  ids,
  receipt,
  T0,
  T1,
} from '../contracts/fixtures.js';
import { ev, payload, snapshot } from '../ui/helpers';
import {
  FakeApiError,
  buttonByText,
  byLabel,
  calls,
  changeValue,
  fakeStream,
  healthDto,
  hostNodes,
  missionDto,
  routedApi,
  sseFrame,
  textOf,
  type FakeStream,
} from './harness';

const M = ids.mission;
const MISSION_PATH = `/nemodots/missions/${M}`;
const SPACES = [{ id: 's1', name: 'Home' }];
const checkoutHealth = {
  status: 'ok',
  postgres: true,
  redis: true,
  config_parse: true,
  writes: true,
  errorClasses: [],
  sampledAt: T0,
};

let root: ReactTestRenderer;
let fetchMock: ReturnType<typeof vi.fn>;
let streams: FakeStream[];
const onOpenMission = vi.fn();
const onBack = vi.fn();

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

async function render(missionId?: string) {
  await act(async () => {
    root = create(
      createElement(MissionPage, {
        missionId,
        spaces: SPACES,
        onOpenMission,
        onBack,
      }),
    );
  });
  await settle();
}

const baseRoutes = (extra: Record<string, unknown> = {}) => ({
  'GET /nemodots/health': healthDto(),
  'GET /nemodots/sandbox/checkout/health': checkoutHealth,
  'GET /nemodots/missions': [],
  [`GET ${MISSION_PATH}`]: snapshot(),
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.mockReset();
  onOpenMission.mockReset();
  onBack.mockReset();
  openPageLink.mockReset();
  streams = [];
  fetchMock = vi.fn(async () => {
    const stream = fakeStream();
    streams.push(stream);
    return stream.response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('list view and create form', () => {
  it('shows BLOCKED with the missing names and a disabled create form', async () => {
    routedApi(
      api,
      baseRoutes({
        'GET /nemodots/health': healthDto({
          mode: 'blocked',
          intelligence: 'blocked',
          missingEnv: ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
        }),
      }),
    );
    await render();
    const text = textOf(root);
    expect(text).toContain('Blocked');
    expect(text).toContain('BLOCKED: mission creation needs');
    expect(text).toContain('OPENAI_BASE_URL');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('Intelligence blocked');
    expect(
      root.root.findAll((n) =>
        String(n.props.className).includes('nd-mode-blocked'),
      ).length,
    ).toBeGreaterThan(0);
    const submit = buttonByText(root.root, 'Create mission');
    expect(submit.props.disabled).toBe(true);
    for (const area of root.root.findAllByType('textarea'))
      expect(area.props.disabled).toBe(true);
    // Even a forced submit never reaches the API.
    await act(async () => {
      await byLabel(root.root, 'Create mission')[0].props.onSubmit({
        preventDefault() {},
      });
    });
    expect(calls(api, 'POST /nemodots/missions')).toHaveLength(0);
  });

  it('creates a mission with goal, constraints and minAgeMs and opens it', async () => {
    routedApi(
      api,
      baseRoutes({
        'POST /nemodots/missions': () => missionDto({ id: ids.mission2 }),
      }),
    );
    await render();
    const textareas = root.root.findAllByType('textarea');
    expect(buttonByText(root.root, 'Create mission').props.disabled).toBe(
      false,
    );
    await act(async () => {
      changeValue(textareas[0], '  Restore checkout  ');
      changeValue(textareas[1], 'no data loss\n\n keep orders \n');
      changeValue(root.root.findByType('input'), '2500');
    });
    await act(async () => {
      await byLabel(root.root, 'Create mission')[0].props.onSubmit({
        preventDefault() {},
      });
    });
    const [post] = calls(api, 'POST /nemodots/missions');
    expect(post[2]).toEqual({
      goal: 'Restore checkout',
      constraints: ['no data loss', 'keep orders'],
      mode: 'live',
      admission: { minAgeMs: 2500 },
    });
    expect(onOpenMission).toHaveBeenCalledWith(ids.mission2);
  });

  it('rejects an out-of-range admission delay without calling the API', async () => {
    routedApi(api, baseRoutes());
    await render();
    await act(async () => {
      changeValue(root.root.findAllByType('textarea')[0], 'Goal');
      changeValue(root.root.findByType('input'), '60001');
    });
    await act(async () => {
      await byLabel(root.root, 'Create mission')[0].props.onSubmit({
        preventDefault() {},
      });
    });
    expect(textOf(root)).toContain('Admission delay must be a whole number');
    expect(calls(api, 'POST /nemodots/missions')).toHaveLength(0);
  });

  it('lists missions with a Fixture marker and opens one', async () => {
    routedApi(
      api,
      baseRoutes({
        'GET /nemodots/missions': [
          missionDto(),
          missionDto({ id: ids.mission2, mode: 'fixture', goal: 'Rehearse' }),
        ],
      }),
    );
    await render();
    const text = textOf(root);
    expect(text).toContain('Restore checkout');
    expect(text).toContain('Rehearse');
    expect(text).toContain('Fixture');
    const link = root.root.findAll(
      (n) => n.type === 'a' && String(n.props.href).endsWith(ids.mission2),
    )[0];
    await act(async () => link.props.onClick({ preventDefault() {} }));
    expect(onOpenMission).toHaveBeenCalledWith(ids.mission2);
  });
});

describe('mission view', () => {
  it('renders the eight views from a snapshot', async () => {
    routedApi(api, baseRoutes());
    await render(M);
    const text = textOf(root);
    expect(text).toContain('Restore checkout'); // goal
    expect(text).toContain('api.inference.crusoecloud.com');
    expect(text).toContain('NVIDIA-Nemotron-3-Super-120B-A12B');
    expect(text).toContain('admission.minAgeMs 3,000 ms');
    expect(text).toContain('Live');
    expect(text).toContain('Intelligence configured');
    expect(text).toContain('Investigate checkout errors'); // task tree
    expect(text).toContain('checkout.config/cache.namespace'); // ledger
    expect(text).toContain('Dependencies');
    expect(text).toContain('Action inspector');
    expect(text).toContain('Recovery timeline');
    expect(text).toContain('System health');
    expect(text).toContain('Manual source edit');
    expect(text).toContain('Injector run');
    expect(text).toContain('Telemetry');
    expect(text).toContain('Model calls');
    // Snapshot first, then a stream resuming from its lastEventId.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Last-Event-ID']).toBe(
      '17',
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/nemodots/missions/${M}/events`,
    );
    expect(text).toContain('Live updates: Open');
  });

  it('shows the FIXTURE badge for a fixture mission, never Live', async () => {
    routedApi(
      api,
      baseRoutes({
        [`GET ${MISSION_PATH}`]: snapshot({
          mission: missionDto({ mode: 'fixture' }),
        }),
      }),
    );
    await render(M);
    const text = textOf(root);
    expect(text).toContain('FIXTURE mission');
    const badge = byLabel(root.root, 'Mission summary')[0].findAll((n) =>
      String(n.props.className ?? '').includes('nd-mode-'),
    );
    const classes = badge.map((n) => String(n.props.className)).join(' ');
    expect(classes).toContain('nd-mode-fixture');
    expect(classes).not.toContain('nd-mode-live');
  });

  it('applies streamed events, dropping duplicates and accepting out-of-order ids', async () => {
    routedApi(api, baseRoutes());
    await render(M);
    const started = ev(
      20,
      payload('attempt.started', { attemptId: ids.attempt2 }),
    );
    const late = ev(
      18,
      payload('task.status', {
        taskId: ids.task,
        from: 'running',
        to: 'failed',
      }),
    );
    const newer = ev(
      19,
      payload('task.status', {
        taskId: ids.task,
        from: 'running',
        to: 'succeeded',
      }),
    );
    await act(async () => {
      streams[0].push(sseFrame(started), sseFrame(newer));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    // 19 arrived before 18; the late lower id must not overwrite it.
    await act(async () => {
      streams[0].push(sseFrame(late), sseFrame(newer), sseFrame(started));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    const text = textOf(root);
    expect(text).toContain('Succeeded');
    expect(text).not.toMatch(/Investigate checkout errors[^]*Failed/);
    // The attempt started twice counts once: snapshot attempt + attempt2.
    expect(text).toContain('2 attempts');
    expect(text).not.toContain('3 attempts');
  });

  it('reads the failure reason from storage when a status event moves the mission to failed', async () => {
    let failed = false;
    const reason = 'task 11111111-1111-4111-8111-111111111111 failed';
    routedApi(
      api,
      baseRoutes({
        [`GET ${MISSION_PATH}`]: () =>
          snapshot(
            failed
              ? {
                  mission: {
                    ...missionDto(),
                    status: 'failed',
                    failureReason: reason,
                  },
                  lastEventId: 21,
                }
              : {},
          ),
      }),
    );
    await render(M);
    expect(textOf(root)).not.toContain('Failure reason');
    failed = true;
    await act(async () => {
      // the event names the new status only; the reason lives with the mission row
      streams[0].push(
        sseFrame(
          ev(
            21,
            payload('mission.status', {
              from: 'running',
              to: 'failed',
              reason: 'task_failed',
            }),
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    const text = textOf(root);
    expect(text).toContain('Failure reason');
    expect(text).toContain(reason);
  });

  it('re-reads the snapshot slowly while the stream is open, so a later lastConfirmedAt shows', async () => {
    let confirmedAt: string = T1;
    routedApi(
      api,
      baseRoutes({
        [`GET ${MISSION_PATH}`]: () =>
          snapshot({ confirmations: [{ ...confirmation(), confirmedAt }] }),
      }),
    );
    await render(M);
    await act(async () => {
      streams[0].push(sseFrame(ev(18, payload('heartbeat'))));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(textOf(root)).toContain('Live updates: Open');
    const before = calls(api, `GET ${MISSION_PATH}`).length;
    // no 3 s polling while the stream is open ...
    await settle(9000);
    expect(calls(api, `GET ${MISSION_PATH}`).length).toBe(before);
    // ... but the page reconciles with storage at the slower cadence
    confirmedAt = T1.replace(/T\d\d:\d\d:\d\d/, 'T23:59:59');
    await settle(25_000);
    expect(calls(api, `GET ${MISSION_PATH}`).length).toBeGreaterThan(before);
  });

  it('never renders control data or prompts carried by a stray payload key', async () => {
    routedApi(api, baseRoutes());
    await render(M);
    const base = eventPayloads()['task.created'];
    const raw = {
      id: 18,
      missionId: M,
      kind: 'task.created',
      at: T0,
      payload: {
        ...base,
        control: { prompt: 'SECRET-PROMPT-TEXT', env: 'SECRET-ENV-VALUE' },
        task: {
          ...(base.task as object),
          id: ids.task2,
          title: 'Second task',
          prompt: 'SECRET-PROMPT-TEXT',
        },
      },
    };
    await act(async () => {
      streams[0].push(sseFrame(raw));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    const text = textOf(root);
    expect(text).toContain('Second task');
    expect(text).not.toContain('SECRET');
  });

  it('shows reconnecting then open after a stream error, polling snapshots meanwhile', async () => {
    routedApi(api, baseRoutes());
    for (let i = 0; i < 3; i += 1)
      fetchMock.mockImplementationOnce(async () => {
        throw new TypeError('network down');
      });
    await render(M);
    expect(textOf(root)).toContain('Live updates: Reconnecting');
    expect(textOf(root)).toContain('refreshing from storage every 3 seconds');
    const before = calls(api, `GET ${MISSION_PATH}`).length;
    await settle(3100);
    expect(calls(api, `GET ${MISSION_PATH}`).length).toBeGreaterThan(before);
    await settle(40000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(textOf(root)).toContain('Live updates: Open');
    // Resumes from the snapshot id, and stops polling once the stream is open.
    const resumed = fetchMock.mock.calls[3][1] as RequestInit;
    expect((resumed.headers as Record<string, string>)['Last-Event-ID']).toBe(
      '17',
    );
    const settled = calls(api, `GET ${MISSION_PATH}`).length;
    await settle(9000);
    expect(calls(api, `GET ${MISSION_PATH}`).length).toBe(settled);
  });

  it('reconstructs from the snapshot after a remount', async () => {
    routedApi(api, baseRoutes());
    await render(M);
    expect(textOf(root)).not.toContain('Added after refresh');
    await act(async () => root.unmount());
    const created = snapshot({
      lastEventId: 31,
      tasks: [
        ...snapshot().tasks,
        {
          ...snapshot().tasks[0],
          id: ids.task2,
          title: 'Added after refresh',
          ordinal: 1,
        },
      ],
    });
    routedApi(api, baseRoutes({ [`GET ${MISSION_PATH}`]: created }));
    await render(M);
    expect(textOf(root)).toContain('Added after refresh');
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Last-Event-ID']).toBe(
      '31',
    );
  });

  it('recovers when the first snapshot fails transiently while the stream opens', async () => {
    let attempts = 0;
    routedApi(
      api,
      baseRoutes({
        [`GET ${MISSION_PATH}`]: () => {
          attempts += 1;
          if (attempts === 1) throw new FakeApiError('Bad gateway', 502);
          return snapshot();
        },
      }),
    );
    await render(M);
    expect(textOf(root)).toContain('Loading mission');
    await settle(100);
    expect(textOf(root)).toContain('Live updates: Open');
    await settle(3100);
    const text = textOf(root);
    expect(attempts).toBeGreaterThan(1);
    expect(text).toContain('Restore checkout');
    expect(text).toContain('Investigate checkout errors');
    expect(text).not.toContain('Bad gateway');
    expect(text).not.toContain('Loading mission');
    // Once merged and open, polling stops.
    const settled = attempts;
    await settle(9000);
    expect(attempts).toBe(settled);
  });

  it('badges a live mission Live even while the server is in fixture mode', async () => {
    routedApi(
      api,
      baseRoutes({
        'GET /nemodots/health': healthDto({ mode: 'fixture' }),
      }),
    );
    await render(M);
    const head = byLabel(root.root, 'Mission summary')[0];
    const classes = head
      .findAll((n) => String(n.props.className ?? '').includes('nd-mode-'))
      .map((n) => String(n.props.className))
      .join(' ');
    expect(classes).toContain('nd-mode-live');
    expect(classes).not.toContain('nd-mode-fixture');
    expect(textOf(root)).toContain('server is now in fixture mode');
  });

  it('reports an unknown mission without opening a stream', async () => {
    routedApi(api, {
      ...baseRoutes(),
      [`GET ${MISSION_PATH}`]: new FakeApiError('Mission not found.', 404),
    });
    await render(M);
    expect(textOf(root)).toContain('Mission not found.');
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () =>
      buttonByText(root.root, 'Back to missions').props.onClick(),
    );
    expect(onBack).toHaveBeenCalled();
  });

  it('enables lifecycle controls by status and posts the action', async () => {
    routedApi(
      api,
      baseRoutes({
        [`POST ${MISSION_PATH}/pause`]: missionDto({ status: 'paused' }),
      }),
    );
    await render(M);
    const start = buttonByText(root.root, 'Start');
    const pause = buttonByText(root.root, 'Pause');
    expect(start.props.disabled).toBe(true);
    expect(String(start.props.title)).toContain('running');
    expect(pause.props.disabled).toBe(false);
    await act(async () => pause.props.onClick());
    expect(calls(api, `POST ${MISSION_PATH}/pause`)).toHaveLength(1);
  });

  it('surfaces a lifecycle failure as an alert', async () => {
    routedApi(
      api,
      baseRoutes({
        [`POST ${MISSION_PATH}/cancel`]: new FakeApiError(
          'Illegal transition.',
          409,
        ),
      }),
    );
    await render(M);
    await act(async () => buttonByText(root.root, 'Cancel').props.onClick());
    const alerts = root.root.findAll((n) => n.props.role === 'alert');
    expect(alerts.map((n) => n.children.join(''))).toContain(
      'Illegal transition.',
    );
  });

  it('saves an evidence page with receipt id and revision per line and links back', async () => {
    routedApi(
      api,
      baseRoutes({
        'POST /spaces/s1/pages': (body: unknown) => ({
          id: 'p1',
          spaceId: 's1',
          title: (body as { title: string }).title,
        }),
      }),
    );
    await render(M);
    await act(async () =>
      buttonByText(root.root, 'Save evidence page').props.onClick(),
    );
    const [post] = calls(api, 'POST /spaces/s1/pages');
    const body = post[2] as { title: string; content: string };
    expect(body.title).toContain('Evidence: Restore checkout');
    expect(body.content).toContain(
      `projection of ledger fact ${receipt().id} rev ${receipt().sourceRevision}`,
    );
    expect(body.content).toContain(`(/#/missions/${M})`);
    const link = root.root.findAll(
      (n) => n.type === 'a' && n.props.href === '#/spaces/s1/pages/p1',
    )[0];
    await act(async () => link.props.onClick({ preventDefault() {} }));
    expect(openPageLink).toHaveBeenCalledWith('/#/spaces/s1/pages/p1');
  });

  it('applies a manual source edit with the current revision and runs the injector', async () => {
    routedApi(
      api,
      baseRoutes({
        'POST /nemodots/sandbox/sources/checkout.config%2Fcache.namespace': {
          key: 'checkout.config/cache.namespace',
          version: 4,
        },
        'POST /nemodots/sandbox/injector/run': { runId: 'run-7' },
      }),
    );
    await render(M);
    const form = byLabel(root.root, 'Manual source edit')[0];
    const selects = form.findAllByType('select');
    await act(async () => {
      changeValue(selects[0], 'checkout.config/cache.namespace');
      changeValue(form.findByType('input'), 'orders-b');
    });
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
    });
    const [edit] = calls(
      api,
      'POST /nemodots/sandbox/sources/checkout.config%2Fcache.namespace',
    );
    expect(edit[2]).toEqual({ value: 'orders-b', expectedVersion: 3 });
    expect(textOf(root)).toContain('is now at version 4');

    const injector = byLabel(root.root, 'Injector run')[0];
    await act(async () =>
      changeValue(injector.findByType('input'), 'benign_change'),
    );
    await act(async () => {
      await injector.props.onSubmit({ preventDefault() {} });
    });
    expect(calls(api, 'POST /nemodots/sandbox/injector/run')[0][2]).toEqual({
      scenarioClass: 'benign_change',
    });
    expect(textOf(root)).toContain('Injector run run-7 started.');
  });

  it('keeps every control reachable by keyboard', async () => {
    routedApi(
      api,
      baseRoutes({
        'GET /nemodots/missions': [missionDto()],
      }),
    );
    await render(M);
    const nodes = hostNodes(root.root);
    const native = new Set(['button', 'a', 'input', 'select', 'textarea']);
    for (const node of nodes) {
      if (node.props.onClick || node.props.onSubmit) {
        if (node.type === 'form') continue;
        expect(native.has(node.type as string)).toBe(true);
      }
      if (native.has(node.type as string))
        expect(
          node.props.tabIndex === undefined || node.props.tabIndex >= 0,
        ).toBe(true);
      if (node.type === 'button') expect(node.props.type).toBeDefined();
    }
    const buttons = nodes.filter((node) => node.type === 'button');
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    // Selectable rows are real buttons with aria-current for the selection.
    const row = buttons.find((node) =>
      String(node.props.className).includes('nd-task-row'),
    );
    expect(row).toBeDefined();
    await act(async () => row!.props.onClick());
    expect(
      root.root.findAll(
        (n) => n.type === 'button' && n.props['aria-current'] === 'true',
      ).length,
    ).toBeGreaterThan(0);
  });
});
