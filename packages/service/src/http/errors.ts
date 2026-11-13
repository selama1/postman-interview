import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

/**
 * Error convention (hard rule): every failure states the REASON and the FIX.
 *
 * Wire shape: RFC 9457 problem+json, extended with `code` (stable, machine-readable),
 * `fix` (what the caller should do), `errors` (per-field validation issues) and `requestId`
 * (grep it in the logs).
 *
 *   { "type": "urn:problem:NOT_FOUND", "title": "Not Found", "status": 404,
 *     "code": "NOT_FOUND", "detail": "shipment 42 does not exist",
 *     "fix": "List shipments with GET /shipments to find a valid id.", "requestId": "..." }
 *
 * Throw AppError (or a helper below) from handlers/repos; never hand-build error replies.
 * Postgres constraint errors are translated centrally, so a UNIQUE/FK/CHECK constraint in a
 * migration automatically becomes a correct 409/422 — prefer constraints over app-level checks.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fix?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (resource: string, id: unknown, fix?: string) =>
  new AppError(404, 'NOT_FOUND', `${resource} ${String(id)} does not exist`, fix ?? `Check the ${resource} id.`);

export const conflict = (message: string, fix: string, extra?: Record<string, unknown>) =>
  new AppError(409, 'CONFLICT', message, fix, extra);

export const badRequest = (code: string, message: string, fix: string, extra?: Record<string, unknown>) =>
  new AppError(400, code, message, fix, extra);

export const unprocessable = (code: string, message: string, fix: string, extra?: Record<string, unknown>) =>
  new AppError(422, code, message, fix, extra);

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  fix?: string | undefined;
  errors?: Array<{ path: string; message: string }> | undefined;
  requestId: string;
  [k: string]: unknown;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function problem(req: FastifyRequest, status: number, code: string, detail: string, rest: Partial<Problem> = {}): Problem {
  return {
    type: `urn:problem:${code}`,
    title: TITLES[status] ?? 'Error',
    status,
    code,
    detail,
    ...rest,
    requestId: String(req.id),
  };
}

/** Postgres SQLSTATE -> HTTP. https://www.postgresql.org/docs/current/errcodes-appendix.html */
function fromPg(err: { code?: string; detail?: string; constraint?: string; column?: string; message: string }) {
  const where = err.constraint ? ` (constraint ${err.constraint})` : err.column ? ` (column ${err.column})` : '';
  switch (err.code) {
    case '23505':
      return { status: 409, code: 'CONFLICT', detail: `${err.detail ?? 'duplicate value'}${where}`, fix: 'Use a different value for the unique field, or update the existing record instead.' };
    case '23503':
      return { status: 409, code: 'REFERENCE_VIOLATION', detail: `${err.detail ?? 'referenced row does not exist or is still referenced'}${where}`, fix: 'Create the referenced record first, or remove the records that reference this one.' };
    case '23502':
      return { status: 400, code: 'MISSING_FIELD', detail: `a required value is missing${where}`, fix: 'Provide the missing field.' };
    case '23514':
      return { status: 422, code: 'CONSTRAINT_VIOLATION', detail: `value violates a rule${where}`, fix: 'Check the allowed values/ranges for this field.' };
    case '23P01':
      return { status: 409, code: 'OVERLAP', detail: `overlaps an existing record${where}`, fix: 'Choose a non-overlapping range.' };
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return { status: 400, code: 'INVALID_INPUT', detail: err.message, fix: 'Check the value format (ids, numbers, dates).' };
    case '40001':
    case '40P01':
      return { status: 409, code: 'RETRYABLE_CONFLICT', detail: 'concurrent update conflict', fix: 'Retry the request.' };
    case '57014':
      return { status: 503, code: 'QUERY_TIMEOUT', detail: 'the query exceeded the statement timeout', fix: 'Narrow the request (filters, smaller page) or retry later.' };
    case '53300':
      return { status: 503, code: 'DB_BUSY', detail: 'too many database connections', fix: 'Retry later.' };
    default:
      return null;
  }
}

function isPgError(err: unknown): err is { code: string; message: string; detail?: string; constraint?: string; column?: string } {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((err as { code: string }).code) && 'severity' in err;
}

export function registerErrorHandling(app: FastifyInstance, { exposeInternal }: { exposeInternal: boolean }) {
  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .type('application/problem+json')
      .send(problem(req, 404, 'ROUTE_NOT_FOUND', `no route for ${req.method} ${req.url}`, { fix: 'See GET /openapi.json (or /docs) for available routes.' }));
  });

  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const send = (p: Problem) => reply.code(p.status).type('application/problem+json').send(p);

    if (hasZodFastifySchemaValidationErrors(err)) {
      const errors = err.validation.map((v) => ({
        path: `${err.validationContext ?? 'body'}${v.instancePath ? v.instancePath.replaceAll('/', '.') : ''}`,
        message: v.message ?? 'invalid',
      }));
      return send(problem(req, 400, 'VALIDATION_FAILED', `request ${err.validationContext ?? 'input'} is invalid`, {
        errors,
        fix: 'Correct the fields listed in `errors` (see the schema at /docs).',
      }));
    }

    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, err.message);
      return send(problem(req, err.status, err.code, err.message, { fix: err.fix, ...err.extra }));
    }

    if (isPgError(err)) {
      const mapped = fromPg(err);
      if (mapped) {
        req.log.info({ pgCode: err.code, constraint: err.constraint }, `db error mapped to ${mapped.status}`);
        return send(problem(req, mapped.status, mapped.code, mapped.detail, { fix: mapped.fix }));
      }
    }

    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause.issues }, 'response does not match its schema');
      return send(problem(req, 500, 'RESPONSE_SCHEMA_MISMATCH', exposeInternal ? `response failed schema: ${err.message}` : 'internal error', {
        fix: 'Server bug: the handler returned a shape that does not match its response schema.',
      }));
    }

    const code = (err as { code?: string }).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === '57P01' || /Connection terminated|timeout exceeded when trying to connect/i.test(err.message)) {
      req.log.error({ err }, 'database unavailable');
      return send(problem(req, 503, 'DB_UNAVAILABLE', 'the database is unavailable', { fix: 'Retry shortly; operators: check GET /health/db and `docker compose ps db`.' }));
    }

    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return send(problem(req, status, code ?? 'BAD_REQUEST', err.message, { fix: 'Correct the request and retry.' }));
    }

    req.log.error({ err }, 'unhandled error');
    return send(problem(req, 500, 'INTERNAL', exposeInternal ? err.message : 'internal error', {
      fix: `Server bug — report requestId ${String(req.id)}.`,
    }));
  });
}
