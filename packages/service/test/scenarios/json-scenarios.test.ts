/** Runs every test/scenarios/*.scenario.json on the current target (integration and e2e). */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { uniq } from '../harness/client.js';
import { loadScenarioFile, runScenario } from '../harness/scenario.js';
import { useTarget } from '../harness/server.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.scenario.json'));

describe.each(files)('%s', (file) => {
  const t = useTarget();
  const sc = loadScenarioFile(path.join(dir, file));
  it(sc.name, async () => {
    await runScenario(t.client, sc.steps, { uniq: uniq('s'), ...sc.vars });
  });
});
