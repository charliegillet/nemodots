import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));

import { api } from '../../../src/client/api';
import * as client from '../../../src/client/nemodots/mission-api';
import { NEMODOTS_ROUTES } from '../../../src/server/nemodots/contracts/index.js';

const mocked = vi.mocked(api);
beforeEach(() => {
  mocked.mockReset();
  mocked.mockResolvedValue({} as never);
});

const lastCall = () =>
  mocked.mock.calls.at(-1) as unknown as [
    string,
    string,
    unknown,
    AbortSignal | undefined,
  ];

describe('mission-api', () => {
  it('uses the nemodots prefix, method and body for each route', async () => {
    const signal = new AbortController().signal;
    await client.getHealth(signal);
    expect(lastCall()).toEqual(['/nemodots/health', 'GET', undefined, signal]);
    await client.createMission({ goal: 'Restore checkout' });
    expect(lastCall().slice(0, 3)).toEqual([
      '/nemodots/missions',
      'POST',
      { goal: 'Restore checkout' },
    ]);
    await client.listMissions();
    expect(lastCall().slice(0, 2)).toEqual(['/nemodots/missions', 'GET']);
    await client.getMissionSnapshot('abc');
    expect(lastCall().slice(0, 2)).toEqual(['/nemodots/missions/abc', 'GET']);
    for (const action of ['start', 'pause', 'resume', 'cancel'] as const) {
      await client.runMissionLifecycle('abc', action);
      expect(lastCall().slice(0, 3)).toEqual([
        `/nemodots/missions/abc/${action}`,
        'POST',
        {},
      ]);
    }
    await client.cancelMission('abc');
    expect(lastCall()[0]).toBe('/nemodots/missions/abc/cancel');
    await client.getMissionTasks('abc');
    await client.getMissionEvidence('abc');
    await client.getMissionActions('abc');
    await client.getMissionRecovery('abc');
    await client.getMissionTelemetry('abc');
    expect(mocked.mock.calls.slice(-5).map((c) => c[0])).toEqual([
      '/nemodots/missions/abc/tasks',
      '/nemodots/missions/abc/evidence',
      '/nemodots/missions/abc/actions',
      '/nemodots/missions/abc/recovery',
      '/nemodots/missions/abc/telemetry',
    ]);
    await client.runInjector({ scenarioClass: 'cache_stale' });
    expect(lastCall().slice(0, 3)).toEqual([
      '/nemodots/sandbox/injector/run',
      'POST',
      { scenarioClass: 'cache_stale' },
    ]);
    await client.getCheckoutHealth();
    expect(lastCall()[0]).toBe('/nemodots/sandbox/checkout/health');
    await client.getEvalsReport();
    expect(lastCall()[0]).toBe('/nemodots/evals/report');
  });

  it('encodes ids and source keys as single path segments', async () => {
    await client.getMissionSnapshot('a/b?c');
    expect(lastCall()[0]).toBe('/nemodots/missions/a%2Fb%3Fc');
    await client.editSource('checkout.config/cache.namespace', {
      value: 'x',
      expectedVersion: 3,
    });
    expect(lastCall().slice(0, 3)).toEqual([
      '/nemodots/sandbox/sources/checkout.config%2Fcache.namespace',
      'POST',
      { value: 'x', expectedVersion: 3 },
    ]);
  });

  it('telemetry summary takes an optional mission id', async () => {
    await client.getTelemetrySummary();
    expect(lastCall()[0]).toBe('/nemodots/telemetry/summary');
    await client.getTelemetrySummary('m 1');
    expect(lastCall()[0]).toBe('/nemodots/telemetry/summary?missionId=m%201');
  });

  it('covers every non-SSE route in the contract table', () => {
    const covered = new Set([
      'GET /health',
      'POST /missions',
      'GET /missions',
      'GET /missions/:id',
      'POST /missions/:id/start',
      'POST /missions/:id/pause',
      'POST /missions/:id/resume',
      'POST /missions/:id/cancel',
      'GET /missions/:id/tasks',
      'GET /missions/:id/evidence',
      'GET /missions/:id/actions',
      'GET /missions/:id/recovery',
      'GET /missions/:id/telemetry',
      'POST /sandbox/sources/:key',
      'POST /sandbox/injector/run',
      'GET /sandbox/checkout/health',
      'GET /telemetry/summary',
      'GET /evals/report',
    ]);
    const table = NEMODOTS_ROUTES.map((r) => `${r.method} ${r.path}`).filter(
      (r) => r !== 'GET /missions/:id/events',
    );
    expect(new Set(table)).toEqual(covered);
  });

  it('propagates api errors', async () => {
    mocked.mockRejectedValueOnce(new Error('boom'));
    await expect(client.getHealth()).rejects.toThrow('boom');
  });
});
