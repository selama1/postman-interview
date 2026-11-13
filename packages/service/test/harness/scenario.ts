import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import type { TestClient, TestResponse } from './client.js';
import { scrub } from './scrub.js';

/**
 * Declarative scenario steps — write a user journey once, run it against the in-process
 * server (integration) and the compose stack (e2e).
 *
 *   await runScenario(t.client, [
 *     { name: 'create', method: 'POST', path: '/widgets', body: { name: '${name}' },
 *       expect: { status: 201, json: { name: '${name}' } }, capture: { id: 'body.id' } },
 *     { name: 'read back', method: 'GET', path: '/widgets/${id}', expect: { status: 200 } },
 *     { name: 'missing', method: 'GET', path: '/widgets/999999', expect: { problem: [404, 'NOT_FOUND'] } },
 *   ], { name: uniq('w') });
 *
 * - `${var}` interpolates captured/initial vars into path, query, headers and (deep) body.
 *   A string that is exactly "${var}" keeps the var's type (number stays number).
 * - expect.json is a PARTIAL match (toMatchObject). expect.problem checks problem+json shape.
 * - capture: { var: 'body.items.0.id' | 'headers.location' }.
 * - snapshot: true -> scrubbed (ids/timestamps/request ids masked) body snapshot.
 * - JSON scenario files (test/scenarios/*.scenario.json) support "include": "fragments/x.json".
 */
export interface Step {
  name?: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  expect?: {
    status?: number | number[];
    json?: unknown;
    problem?: [number, string?];
    headers?: Record<string, string>;
    /** custom check; throw to fail */
    check?: (res: TestResponse, vars: Vars) => void | Promise<void>;
  };
  capture?: Record<string, string>;
  snapshot?: boolean;
}
export type Vars = Record<string, unknown>;

const getPath = (obj: unknown, p: string): unknown =>
  p.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);

export function interpolate<T>(value: T, vars: Vars): T {
  if (typeof value === 'string') {
    const whole = /^\$\{([\w.]+)\}$/.exec(value);
    if (whole) return (getPath(vars, whole[1]!) ?? value) as T;
    return value.replace(/\$\{([\w.]+)\}/g, (m, k: string) => {
      const v = getPath(vars, k);
      return v === undefined ? m : String(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)])) as T;
  }
  return value;
}

export async function runScenario(client: TestClient, steps: Step[], initial: Vars = {}): Promise<Vars> {
  const vars: Vars = { ...initial };
  for (const [i, raw] of steps.entries()) {
    const step = interpolate(raw, vars);
    const label = `step ${i + 1}${step.name ? ` "${step.name}"` : ''}`;
    const res = await client.request({
      method: step.method,
      path: step.path,
      query: step.query as never,
      body: step.body,
      headers: step.headers,
    });
    const e = step.expect ?? {};
    try {
      if (e.problem) expect(res).toBeProblem(e.problem[0], e.problem[1]);
      else if (e.status !== undefined) expect(res).toHaveStatus(e.status);
      else expect(res).toHaveStatus([200, 201, 202, 204]);
      if (e.json !== undefined) expect(res.body).toMatchObject(e.json as object);
      for (const [h, v] of Object.entries(e.headers ?? {})) expect(res.headers[h.toLowerCase()]).toBe(v);
      await e.check?.(res, vars);
      if (step.snapshot) expect(scrub(res.body)).toMatchSnapshot(label);
    } catch (err) {
      (err as Error).message = `${label} failed: ${(err as Error).message}\n\nRecent exchanges:\n${client.transcript(3)}`;
      throw err;
    }
    for (const [name, p] of Object.entries(step.capture ?? {})) {
      const v = getPath(res, p);
      if (v === undefined) throw new Error(`${label}: capture "${name}" from "${p}" found nothing\n${client.transcript(1)}`);
      vars[name] = v;
    }
  }
  return vars;
}

/** Load a JSON scenario file, expanding { "include": "relative/fragment.json" } entries. */
export function loadScenarioFile(file: string): { name: string; vars?: Vars; steps: Step[] } {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; vars?: Vars; steps: Array<Step | { include: string }> };
  const expand = (steps: Array<Step | { include: string }>, base: string): Step[] =>
    steps.flatMap((s) => {
      if ('include' in s) {
        const inc = path.resolve(base, s.include);
        const frag = JSON.parse(readFileSync(inc, 'utf8')) as { steps: Array<Step | { include: string }> };
        return expand(frag.steps, path.dirname(inc));
      }
      return [s];
    });
  return { name: doc.name ?? path.basename(file), ...(doc.vars ? { vars: doc.vars } : {}), steps: expand(doc.steps, path.dirname(file)) };
}
