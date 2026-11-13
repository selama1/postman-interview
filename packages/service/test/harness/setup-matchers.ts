import { expect } from 'vitest';
import { formatExchange, lastExchangeFor, type TestResponse } from './client.js';

/**
 * HTTP-aware matchers. On failure they print the full exchange (request, response body,
 * x-request-id) instead of "expected 500 to be 201".
 *
 *   expect(res).toHaveStatus(201)
 *   expect(res).toBeProblem(404, 'NOT_FOUND')
 */
interface HttpMatchers<R> {
  toHaveStatus(status: number | number[]): R;
  toBeProblem(status: number, code?: string): R;
}

declare module 'vitest' {
  // Must repeat vitest's exact type parameters (vitest 5).
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends HttpMatchers<R> {}
}

const describeRes = (res: TestResponse) => {
  const ex = lastExchangeFor(res);
  return ex ? formatExchange(ex) : JSON.stringify(res, null, 2);
};

expect.extend({
  toHaveStatus(res: TestResponse, status: number | number[]) {
    const want = Array.isArray(status) ? status : [status];
    const pass = want.includes(res.status);
    return {
      pass,
      message: () => `expected HTTP ${want.join('|')} but got ${res.status}\n${describeRes(res)}`,
    };
  },
  toBeProblem(res: TestResponse, status: number, code?: string) {
    const b = res.body as { code?: string; detail?: string; fix?: string; requestId?: string } | null;
    const ct = res.headers['content-type'] ?? '';
    const problems: string[] = [];
    if (res.status !== status) problems.push(`status ${res.status} != ${status}`);
    if (!ct.includes('application/problem+json')) problems.push(`content-type "${ct}" is not application/problem+json`);
    if (code && b?.code !== code) problems.push(`code "${b?.code}" != "${code}"`);
    if (!b?.detail) problems.push('missing `detail` (the reason)');
    if (!b?.fix) problems.push('missing `fix` (every failure states the fix)');
    if (!b?.requestId) problems.push('missing `requestId`');
    return {
      pass: problems.length === 0,
      message: () => `expected problem ${status}${code ? ` ${code}` : ''}: ${problems.join('; ')}\n${describeRes(res)}`,
    };
  },
});
