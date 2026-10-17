import { resolveInference } from '../config/env.js';

// Inference mode resolution (ARCHITECTURE.md section 10, finding I1).
//
// This is a deliberately thin view over config/env.ts resolveInference so the
// adapter and the server cannot disagree. There is no default base URL: live
// needs OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL, otherwise the mode
// is `blocked` and missingEnv names exactly what is absent. Values are never
// part of the result.

type Env = Record<string, string | undefined>;

export type ModeResolution =
  | {
      mode: 'live';
      missingEnv: [];
      invalidEnv: [];
      host: string;
      model: string;
    }
  | { mode: 'fixture'; missingEnv: []; invalidEnv: []; fixturePath: string }
  | {
      mode: 'blocked';
      missingEnv: string[];
      invalidEnv: string[];
      reason: 'requested' | 'missing_env';
    };

export function resolveMode(env: Env = process.env): ModeResolution {
  const resolved = resolveInference(env);
  if (resolved.mode === 'live')
    return {
      mode: 'live',
      missingEnv: [],
      invalidEnv: [],
      host: resolved.provider.host,
      model: resolved.provider.model,
    };
  if (resolved.mode === 'fixture')
    return {
      mode: 'fixture',
      missingEnv: [],
      invalidEnv: [],
      fixturePath: resolved.fixturePath,
    };
  return resolved;
}
