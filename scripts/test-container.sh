#!/bin/sh
# Runs every test layer inside the compose `tests` container (only Docker needed on the host):
#
#   docker compose --profile test run --rm --build tests      (or: pnpm test:docker)
#
# Layers, against services on the compose network (no host ports involved):
#   1. typecheck + unit + integration   -> db-test:5432 (a fresh cloned DB per test)
#   2. e2e journey                      -> api:3000 (the built service image)
#   3. vitest e2e (e2e + scenarios)     -> api:3000
# Every layer runs even if an earlier one fails; the summary names each result.

: "${TEST_DATABASE_ADMIN_URL:?not set. Fix: run through compose (docker compose --profile test run --rm tests), which sets it to db-test}"
: "${E2E_BASE_URL:?not set. Fix: run through compose (docker compose --profile test run --rm tests), which sets it to http://api:3000}"

unit_int=0; journey=0; e2e=0

echo "== 1/3 typecheck + unit + integration (db: db-test) =="
pnpm test || unit_int=$?

echo
echo "== 2/3 e2e journey ($E2E_BASE_URL) =="
node scripts/e2e-journey.mjs || journey=$?

echo
echo "== 3/3 vitest e2e ($E2E_BASE_URL) =="
TEST_TARGET=e2e pnpm exec vitest run --project e2e || e2e=$?

r() { if [ "$1" -eq 0 ]; then echo PASS; else echo "FAIL (exit $1)"; fi; }
echo
echo "== summary =="
echo "  typecheck + unit + integration  $(r $unit_int)"
echo "  e2e journey                     $(r $journey)"
echo "  vitest e2e                      $(r $e2e)"

if [ $((unit_int + journey + e2e)) -ne 0 ]; then
  echo "TESTS FAILED. The failing layer's output is above. Logs of the service under test:"
  echo "  docker compose logs api        (database: docker compose --profile test logs db-test)"
  exit 1
fi
echo "ALL TEST LAYERS PASSED (in the tests container, against db-test and the api image)."
