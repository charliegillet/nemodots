import type pg from 'pg';
import {
  CheckoutHealthResponseSchema,
  CheckoutStatusSchema,
  type CheckoutHealthResponse,
  type HealthStatus,
} from '../contracts/index.js';
import { resolveMode } from '../inference/mode.js';

// GET /health and GET /sandbox/checkout/health. Every probe has a timeout and
// reports `down` / unreachable on failure; none of them can throw into the
// route. Only names and the provider host (from OPENAI_BASE_URL) are reported,
// never values, URLs with credentials or response bodies.

type Env = Record<string, string | undefined>;

export interface HealthDeps {
  pool: pg.Pool;
  env: Env;
  /** InferencePort.listModels; used in live mode to prove the model is served. */
  listModels?: () => Promise<string[]>;
  pingRedis?: () => Promise<boolean>;
  checkout: CheckoutProxy | null;
  intelligenceConfigured: () => boolean;
  incidentDotIds: () => number;
  now: () => Date;
  probeTimeoutMs: number;
  /** How long a provider /models result is reused. */
  providerTtlMs: number;
}

export interface CheckoutProxy {
  /** Base URL of the checkout API (NEMODOTS_CHECKOUT_PORT); never returned to clients. */
  baseUrl: string;
  fetch?: typeof fetch;
}

function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export function providerHost(env: Env): string | null {
  const raw = env.OPENAI_BASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

export function createHealth(deps: HealthDeps) {
  let providerCache: {
    at: number;
    reachable: boolean;
    modelListed: boolean;
    checkedAt: string;
  } | null = null;

  async function provider(model: string) {
    const nowMs = deps.now().getTime();
    if (providerCache && nowMs - providerCache.at < deps.providerTtlMs)
      return providerCache;
    let reachable = false;
    let modelListed = false;
    if (deps.listModels) {
      const listed = await withTimeout<string[] | null>(
        deps.listModels,
        deps.probeTimeoutMs,
        null,
      );
      reachable = listed !== null;
      modelListed = listed?.includes(model) ?? false;
    }
    providerCache = {
      at: nowMs,
      reachable,
      modelListed,
      checkedAt: deps.now().toISOString(),
    };
    return providerCache;
  }

  return async function health(): Promise<HealthStatus> {
    const resolved = resolveMode(deps.env);
    const [postgres, redis, checkout] = await Promise.all([
      withTimeout(
        async () => {
          await deps.pool.query('SELECT 1');
          return true;
        },
        deps.probeTimeoutMs,
        false,
      ),
      deps.pingRedis
        ? withTimeout(deps.pingRedis, deps.probeTimeoutMs, false)
        : Promise.resolve(false),
      checkoutHealth(deps),
    ]);

    let providerState: HealthStatus['provider'] = {
      reachable: false,
      modelListed: false,
      model: deps.env.OPENAI_MODEL?.trim() || null,
      host: providerHost(deps.env),
      checkedAt: null,
    };
    if (resolved.mode === 'live') {
      const checked = await provider(resolved.model);
      providerState = {
        reachable: checked.reachable,
        modelListed: checked.modelListed,
        model: resolved.model,
        host: resolved.host,
        checkedAt: checked.checkedAt,
      };
    }
    return {
      mode: resolved.mode,
      provider: providerState,
      postgres: postgres ? 'ok' : 'down',
      redis: redis ? 'ok' : 'down',
      checkout: {
        reachable: checkout !== null,
        status: checkout?.status ?? null,
      },
      intelligence: deps.intelligenceConfigured() ? 'configured' : 'blocked',
      missingEnv: [...resolved.missingEnv],
      incidentDotIds: deps.incidentDotIds(),
    };
  };
}

/** Raw checkout /health, mapped to the DTO; null when unreachable or malformed. */
export async function fetchCheckoutHealth(
  proxy: CheckoutProxy,
  timeoutMs: number,
  sampledAt: Date,
): Promise<CheckoutHealthResponse | null> {
  try {
    const doFetch = proxy.fetch ?? fetch;
    const response = await doFetch(new URL('/health', proxy.baseUrl), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    // /health answers 503 for degraded and down; the body is the signal.
    const body = (await response.json()) as {
      status?: unknown;
      checks?: Record<string, unknown>;
      errors?: unknown;
    } | null;
    const status = CheckoutStatusSchema.safeParse(body?.status);
    if (!status.success || !body?.checks) return null;
    const checks = body.checks;
    const parsed = CheckoutHealthResponseSchema.safeParse({
      status: status.data,
      postgres: checks.postgres === true,
      redis: checks.redis === true,
      config_parse: checks.config_parse === true,
      writes: checks.writes === true,
      errorClasses: Array.isArray(body.errors)
        ? body.errors.filter((e): e is string => typeof e === 'string')
        : [],
      sampledAt: sampledAt.toISOString(),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function checkoutHealth(deps: HealthDeps) {
  if (!deps.checkout) return null;
  return fetchCheckoutHealth(deps.checkout, deps.probeTimeoutMs, deps.now());
}
