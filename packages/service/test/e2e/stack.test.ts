/** E2E-only checks: properties of the deployed container stack itself. */
import { describe, expect, it } from 'vitest';
import { TestClient } from '../harness/client.js';
import { testEnv } from '../harness/env.js';

describe('compose stack', () => {
  const client = new TestClient(testEnv.e2eBaseUrl);

  it('returns problem+json for unknown routes', async () => {
    expect(await client.get('/no-such-route')).toBeProblem(404, 'ROUTE_NOT_FOUND');
  });

  it('is connected to the compose database (not a test DB), migrations applied on start', async () => {
    const res = await client.get('/health/db');
    expect(res).toHaveStatus(200);
    expect(res.body.database).toBe('app');
    expect(res.body.migrations.pending).toEqual([]);
    expect(res.body.migrations.executed).toBeGreaterThan(0);
  });

  it('handles a burst of 50 concurrent DB-backed requests without errors', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => client.get('/health/db')));
    expect(results.filter((r) => r.status !== 200).map((r) => r.status)).toEqual([]);
  });
});
