// Aggregate metrics bridge. It posts a TelemetrySummary (counts and digests, no
// prompts) to a metrics endpoint with its OWN bearer token. The inference key
// is never a candidate: the bridge refuses a token equal to OPENAI_API_KEY or
// CRUSOE_API_KEY, reads no inference variable, and with no metrics URL or
// token configured it is disabled rather than falling back to anything.
import type { TelemetrySummary } from '../contracts/index.js';
import { assertRedacted } from './export.js';

export const METRICS_URL_ENV = 'NEMODOTS_METRICS_URL';
export const METRICS_TOKEN_ENV = 'NEMODOTS_METRICS_TOKEN';
const INFERENCE_KEY_ENVS = ['OPENAI_API_KEY', 'CRUSOE_API_KEY'] as const;

export type MetricsBridgeConfig =
  | { enabled: false; reason: string }
  | { enabled: true; url: string; token: string };

export function resolveMetricsBridge(
  env: Record<string, string | undefined> = process.env,
): MetricsBridgeConfig {
  const url = env[METRICS_URL_ENV]?.trim();
  const token = env[METRICS_TOKEN_ENV]?.trim();
  if (!url) return { enabled: false, reason: `${METRICS_URL_ENV} is not set` };
  if (!token)
    return { enabled: false, reason: `${METRICS_TOKEN_ENV} is not set` };
  for (const name of INFERENCE_KEY_ENVS)
    if (env[name]?.trim() === token)
      return {
        enabled: false,
        reason: `${METRICS_TOKEN_ENV} must differ from ${name}`,
      };
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username)
      throw new Error('bad url');
  } catch {
    return {
      enabled: false,
      reason: `${METRICS_URL_ENV} is not a valid http(s) URL without credentials`,
    };
  }
  return { enabled: true, url, token };
}

export async function pushSummary(
  config: MetricsBridgeConfig,
  summary: TelemetrySummary,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ sent: boolean; reason: string | null }> {
  if (!config.enabled) return { sent: false, reason: config.reason };
  const body = JSON.stringify({ kind: 'telemetry_summary', summary });
  assertRedacted(body, [config.token]);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body,
      redirect: 'error',
      signal: options.signal,
    });
    return response.ok
      ? { sent: true, reason: null }
      : {
          sent: false,
          reason: `metrics endpoint answered HTTP ${response.status}`,
        };
  } catch {
    return { sent: false, reason: 'metrics endpoint could not be reached' };
  }
}
