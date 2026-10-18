// Stub checkout child for the I3 test: prints the NAMES (never values) of
// its environment, then parses that environment with the shared parser, as
// the real checkout API will, and reports success or the failing names.
import { parseNemoDotsEnv } from '../../../../../src/server/nemodots/config/env.js';

console.log(`ENV_NAMES ${JSON.stringify(Object.keys(process.env).sort())}`);
try {
  const config = parseNemoDotsEnv(process.env);
  console.log(`PARSE_OK pgPort=${config.pg.port}`);
} catch (error) {
  const names = (error as { names?: string[] }).names ?? [];
  console.log(`PARSE_FAILED ${JSON.stringify(names)}`);
  process.exitCode = 1;
}
