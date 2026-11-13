/**
 * REFERENCE RESOURCE — test-only. The canonical shape of a resource in this codebase; copy it
 * when adding a real one (see .claude/skills/feature). It is registered only in harness
 * self-tests (test/integration/harness-*.test.ts), never in the real app.
 *
 * Shows: Kysely table types + row->DTO mapping (snake_case DB, camelCase API), zod request /
 * response schemas (validation + OpenAPI from one source), keyset pagination with an allowlisted
 * multi-column sort, explicit filters, problem errors (404 via notFound, 409 via the UNIQUE
 * constraint mapped centrally), PATCH with partial bodies, 201 + Location.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Generated, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import { badRequest, notFound } from '../../src/http/errors.js';
import { KeysetQuery, keysetPage, keysetResult, pageSchema } from '../../src/http/pagination.js';
import { csvList, likeEscape, parseSort } from '../../src/http/query.js';

// --- DB ---------------------------------------------------------------------------------------
export interface WidgetsTable {
  id: Generated<number>;
  name: string;
  color: string;
  weight_g: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** In a real resource this is a migration (pnpm migrate:make). timestamptz(3): see llms.txt pitfall #3. */
export async function createWidgetsTable(db: Kysely<any>): Promise<void> {
  await sql`
    create table widgets (
      id         bigint generated always as identity primary key,
      name       text not null unique,
      color      text not null check (color in ('red', 'green', 'blue')),
      weight_g   integer not null check (weight_g > 0),
      created_at timestamptz(3) not null default now(),
      updated_at timestamptz(3) not null default now()
    );
    create index widgets_weight_name_idx on widgets (weight_g, name, id);
    create index widgets_created_idx on widgets (created_at, id);
    create trigger widgets_updated_at before update on widgets for each row execute function set_updated_at();
  `.execute(db);
}

// --- API schemas ------------------------------------------------------------------------------
export const Color = z.enum(['red', 'green', 'blue']);
export const WidgetInput = z.object({
  name: z.string().trim().min(1).max(100),
  color: Color,
  weightG: z.number().int().positive(),
});
export const WidgetPatch = WidgetInput.partial().refine((p) => Object.keys(p).length > 0, { message: 'provide at least one field' });
export const Widget = WidgetInput.extend({ id: z.number().int(), createdAt: z.string(), updatedAt: z.string() });
export type Widget = z.infer<typeof Widget>;

const toDto = (r: Selectable<WidgetsTable>): Widget => ({
  id: r.id,
  name: r.name,
  color: r.color as Widget['color'],
  weightG: r.weight_g,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

const SORTABLE = { name: 'name', weightG: 'weight_g', createdAt: 'created_at' } as const;
const IdParams = z.object({ id: z.coerce.number().int().positive() });

// --- routes -----------------------------------------------------------------------------------
export const widgetRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.db.withTables<{ widgets: WidgetsTable }>();

  app.post('/', { schema: { tags: ['widgets'], body: WidgetInput, response: { 201: Widget } } }, async (req, reply) => {
    const row = await db
      .insertInto('widgets')
      .values({ name: req.body.name, color: req.body.color, weight_g: req.body.weightG })
      .returningAll()
      .executeTakeFirstOrThrow();
    return reply.code(201).header('location', `${req.url.replace(/\/$/, '')}/${row.id}`).send(toDto(row));
  });

  app.get(
    '/',
    {
      schema: {
        tags: ['widgets'],
        querystring: KeysetQuery.extend({
          color: csvList(['red', 'green', 'blue']).optional(),
          q: z.string().min(1).max(100).optional(),
          minWeightG: z.coerce.number().int().optional(),
          sort: z.string().optional(),
        }),
        response: { 200: pageSchema(Widget) },
      },
    },
    async (req) => {
      const { limit, cursor, color, q, minWeightG } = req.query;
      const sort = parseSort(req.query.sort, SORTABLE, 'createdAt').map(({ col, dir }) => ({ col, dir }));
      const opts = { sort, id: 'id', limit, cursor };
      let qb = db.selectFrom('widgets').selectAll();
      if (color?.length) qb = qb.where('color', 'in', color);
      if (q) qb = qb.where('name', 'ilike', `%${likeEscape(q)}%`);
      if (minWeightG !== undefined) qb = qb.where('weight_g', '>=', minWeightG);
      const rows = await keysetPage(qb, opts).execute();
      const page = keysetResult(rows, opts, (r) => [...sort.map((s) => r[s.col as keyof typeof r]), r.id]);
      return { items: page.items.map(toDto), nextCursor: page.nextCursor };
    },
  );

  app.get('/:id', { schema: { tags: ['widgets'], params: IdParams, response: { 200: Widget } } }, async (req) => {
    const row = await db.selectFrom('widgets').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!row) throw notFound('widget', req.params.id, 'List widgets with GET /widgets to find a valid id.');
    return toDto(row);
  });

  app.patch('/:id', { schema: { tags: ['widgets'], params: IdParams, body: WidgetPatch, response: { 200: Widget } } }, async (req) => {
    const { name, color, weightG } = req.body;
    if (name === undefined && color === undefined && weightG === undefined) {
      throw badRequest('EMPTY_PATCH', 'no fields to update', 'Send at least one of name, color, weightG.');
    }
    const row = await db
      .updateTable('widgets')
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(weightG !== undefined ? { weight_g: weightG } : {}),
      })
      .where('id', '=', req.params.id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw notFound('widget', req.params.id);
    return toDto(row);
  });

  app.delete('/:id', { schema: { tags: ['widgets'], params: IdParams } }, async (req, reply) => {
    const r = await db.deleteFrom('widgets').where('id', '=', req.params.id).executeTakeFirst();
    if (r.numDeletedRows === 0n) throw notFound('widget', req.params.id);
    return reply.code(204).send();
  });
};

/** Server options that mount the fixture: pass to useTarget()/startTestServer(). */
export const widgetsServer = {
  setup: async (fresh: { db: Kysely<any> }) => createWidgetsTable(fresh.db),
  plugins: [{ plugin: widgetRoutes as never, prefix: '/widgets' }],
};
