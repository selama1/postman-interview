/**
 * Runs on BOTH targets: integration (fresh DB + in-process server) and e2e (compose stack).
 * Only assert things that hold on a shared, non-empty database here.
 */
import { describe, expect, it } from 'vitest';
import { useTarget } from '../harness/server.js';

describe('platform', () => {
  const t = useTarget({ fresh: 'file' });

  it('GET /health is live', async () => {
    const res = await t.client.get('/health');
    expect(res).toHaveStatus(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET /health/db proves a real DB round-trip with all migrations applied', async () => {
    const res = await t.client.get('/health/db');
    expect(res).toHaveStatus(200);
    expect(res.body).toMatchObject({ status: 'ok', migrations: { pending: [] } });
    expect(res.body.serverVersion).toMatch(/^\d+/);
  });

  it('echoes a caller-supplied x-request-id and generates one otherwise', async () => {
    const mine = await t.client.get('/health', undefined, { 'x-request-id': 'trace-abc-123' });
    expect(mine.requestId).toBe('trace-abc-123');
    const gen = await t.client.get('/health');
    expect(gen.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves the OpenAPI document (importable into Postman)', async () => {
    const res = await t.client.get('/openapi.json');
    expect(res).toHaveStatus(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths)).toContain('/health/db');
  });
});
