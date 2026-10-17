import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES } from './requests.js';

const here = dirname(fileURLToPath(import.meta.url));
for (const [name, content] of Object.entries(FIXTURES))
  writeFileSync(join(here, name), `${JSON.stringify(content, null, 2)}\n`);
