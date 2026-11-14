import type { FixtureRegistry } from '../db/template.js';

/**
 * Named initial states for API test sessions (`POST /_test/sessions {"fixture":"<name>"}`) and
 * for the integration harness (`useTarget({ fixture: '<name>' })`).
 *
 * Each fixture's `seed` runs once per fingerprint (migrations + seed source + version) into a
 * sealed template; every test then CLONES it, so a large realistic fixture costs the same per test
 * as an empty DB. Seed with fast bulk SQL (insert ... select / generate_series / COPY), not via the
 * API. Keep fixtures deterministic (fixed ids/timestamps) so tests can assert exact values.
 *
 *   export const fixtures: FixtureRegistry = {
 *     small_fleet: {
 *       description: '3 publishers, 10 authors, 50 books in mixed states',
 *       seed: async (db) => {
 *         await sql`insert into publishers (...) values (...)`.execute(db);
 *       },
 *     },
 *   };
 *
 * Empty in the vanilla scaffold — fixtures arrive with the data.
 */
export const fixtures: FixtureRegistry = {};
