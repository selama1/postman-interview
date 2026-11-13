/**
 * Harness self-test + living example: the contract packs and the scenario runner exercised
 * against the reference `widgets` resource (test/fixtures/widgets.ts).
 * When you add a real resource, copy this file's shape.
 */
import { describe, expect, it } from 'vitest';
import { uniq } from '../harness/client.js';
import { crudContract, paginationContract, uniqueRaceContract, validationContract } from '../harness/packs.js';
import { runScenario } from '../harness/scenario.js';
import { useTarget } from '../harness/server.js';
import { widgetsServer } from '../fixtures/widgets.js';

const COLORS = ['red', 'green', 'blue'] as const;
const make = (i: number) => ({ name: uniq(`w${i}`), color: COLORS[i % 3], weightG: (i % 7) + 1 });

crudContract({
  name: 'widget',
  path: '/widgets',
  make,
  patch: (i) => ({ color: 'blue', weightG: 100 + i }),
  invalidId: 'abc',
  server: widgetsServer,
});

validationContract({
  path: '/widgets',
  valid: make(1),
  cases: [
    { name: 'missing name', body: { color: 'red', weightG: 1 }, field: 'name' },
    { name: 'unknown color', body: { name: 'x', color: 'mauve', weightG: 1 }, field: 'color' },
    { name: 'negative weight', body: { name: 'x', color: 'red', weightG: -5 }, field: 'weightG' },
    { name: 'weight as string', body: { name: 'x', color: 'red', weightG: '5' }, field: 'weightG' },
  ],
  server: widgetsServer,
});

type W = { name: string; weightG: number; createdAt: string; id: number };
const byName = (a: W, b: W) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
paginationContract({
  path: '/widgets',
  make,
  sorts: [
    { sort: 'name', compare: (a, b) => byName(a as W, b as W) },
    // mixed directions + many ties on weight: exercises the expanded keyset OR-chain
    { sort: '-weightG,name', compare: (a, b) => (b as W).weightG - (a as W).weightG || byName(a as W, b as W) },
    {
      sort: '-createdAt',
      compare: (a, b) => (b as W).createdAt.localeCompare((a as W).createdAt) || (b as W).id - (a as W).id,
    },
  ],
  server: widgetsServer,
});

uniqueRaceContract({
  path: '/widgets',
  make: () => ({ name: 'same-name', color: 'red', weightG: 1 }),
  server: widgetsServer,
});

describe('widgets journey (scenario runner)', () => {
  const t = useTarget(widgetsServer);

  it('create -> read -> filter -> rename conflict -> delete', async () => {
    const vars = await runScenario(
      t.client,
      [
        {
          name: 'create',
          method: 'POST',
          path: '/widgets',
          body: { name: '${a}', color: 'red', weightG: 5 },
          expect: { status: 201, json: { name: '${a}' } },
          capture: { id: 'body.id', loc: 'headers.location' },
        },
        { name: 'create other', method: 'POST', path: '/widgets', body: { name: '${b}', color: 'green', weightG: 9 }, expect: { status: 201 } },
        { name: 'read', method: 'GET', path: '${loc}', expect: { status: 200, json: { id: '${id}', color: 'red' } } },
        {
          name: 'filter',
          method: 'GET',
          path: '/widgets',
          query: { color: 'green' },
          expect: { status: 200, json: { items: [{ name: '${b}' }], nextCursor: null } },
        },
        { name: 'rename to existing -> 409', method: 'PATCH', path: '/widgets/${id}', body: { name: '${b}' }, expect: { problem: [409, 'CONFLICT'] } },
        { name: 'delete', method: 'DELETE', path: '/widgets/${id}', expect: { status: 204 } },
      ],
      { a: uniq('a'), b: uniq('b') },
    );
    expect(typeof vars.id).toBe('number');
  });
});
