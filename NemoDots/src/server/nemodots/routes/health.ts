import { HealthStatusSchema, type HealthStatus } from '../contracts/index.js';
import { ResponseContractError } from './errors.js';
import { parseIncidentDotIds } from '../interception/policy-registry.js';
import type { NemodotsRouteDeps } from './types.js';

const settled = async <T>(
  run: (() => Promise<T>) | undefined,
  fallback: T,
): Promise<T> => {
  if (!run) return fallback;
  try {
    return await run();
  } catch {
    return fallback;
  }
};

/** Health from the server-resolved mode and injected probes. Names only, no values. */
export async function buildHealth(
  deps: NemodotsRouteDeps,
): Promise<HealthStatus> {
  const mode = deps.mode();
  const probes = deps.health ?? {};
  const provider = await settled(probes.provider, {
    reachable: false,
    modelListed: false,
    checkedAt: null,
  });
  const postgres = await deps.pool.query('SELECT 1').then(
    () => 'ok' as const,
    () => 'down' as const,
  );
  const redis = await settled<'ok' | 'down'>(probes.redis, 'down');
  const checkout = await settled(probes.checkout, {
    reachable: false,
    status: null,
  });
  const health = HealthStatusSchema.safeParse({
    mode: mode.mode,
    provider: {
      ...provider,
      model: mode.mode === 'live' ? mode.model : null,
      host: mode.mode === 'live' ? mode.host : null,
    },
    postgres,
    redis,
    checkout,
    intelligence: probes.intelligenceConfigured?.() ? 'configured' : 'blocked',
    missingEnv: [...mode.missingEnv, ...mode.invalidEnv].sort(),
    incidentDotIds:
      probes.incidentDotIds?.() ??
      parseIncidentDotIds(process.env.NEMODOTS_INCIDENT_DOT_IDS).size,
  });
  if (!health.success) throw new ResponseContractError();
  return health.data;
}
