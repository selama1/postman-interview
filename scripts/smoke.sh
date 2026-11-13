#!/bin/sh
# Smoke test for a fresh clone. Needs only: sh, Docker (with Compose v2) and curl. No Node.
#
#   sh scripts/smoke.sh              start the stack (build), check it end to end, leave it running
#   sh scripts/smoke.sh --failover   also stop the DB, expect a clean 503, restart it, expect recovery
#   sh scripts/smoke.sh --no-build   reuse the existing image (faster re-runs)
#   sh scripts/smoke.sh --down       tear the stack down at the end (volumes kept)
#
# Every failure prints WHAT happened, the most likely WHY, and HOW to fix it, with evidence
# (command output, container logs), not just an exit code. Exit 0 = every check passed.

set -u
cd "$(dirname "$0")/.." || exit 1

BUILD=--build; FAILOVER=0; DOWN=0
for arg in "$@"; do
  case "$arg" in
    --failover) FAILOVER=1 ;;
    --no-build) BUILD= ;;
    --down) DOWN=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 2 ;;
  esac
done

# ---------- output helpers ----------------------------------------------------------------------
if [ -t 1 ]; then G='\033[32m'; R='\033[31m'; Y='\033[33m'; B='\033[1m'; N='\033[0m'; else G=; R=; Y=; B=; N=; fi
PASSED=0; FAILED=0; WARNED=0; FAILURES=""
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t smoke)
trap 'rm -rf "$TMP"' EXIT

section() { printf '\n%b== %s ==%b\n' "$B" "$1" "$N"; }
pass() { PASSED=$((PASSED + 1)); printf '%bPASS%b  %s\n' "$G" "$N" "$1"; }
warn() { WARNED=$((WARNED + 1)); printf '%bWARN%b  %s\n' "$Y" "$N" "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }
# fail <check> <what happened> <why> <how to fix> [evidence file]
fail() {
  FAILED=$((FAILED + 1)); FAILURES="$FAILURES
  - $1"
  printf '%bFAIL%b  %s\n' "$R" "$N" "$1"
  printf '      What happened: %s\n' "$2"
  printf '      Likely cause:  %s\n' "$3"
  printf '      How to fix:    %s\n' "$4"
  if [ -n "${5:-}" ] && [ -s "$5" ]; then
    printf '      Evidence (last lines):\n'
    tail -n 15 "$5" | sed 's/^/        | /'
  fi
}
logs_of() { docker compose logs --no-color --tail 40 "$1" > "$TMP/$1.log" 2>&1; echo "$TMP/$1.log"; }
# Value of a flat JSON field ("key":"v" or "key":123) without needing jq.
jfield() {
  v=$(sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1)
  [ -n "$v" ] || v=$(sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([-0-9.eE+]*\).*/\1/p" "$2" | head -n 1)
  echo "$v"
}
# http <method> <url> [header] -> sets CODE, CTYPE, CURL_EXIT; body in $TMP/body
http() {
  if [ -n "${3:-}" ]; then
    out=$(curl -s -o "$TMP/body" -w '%{http_code} %{content_type}' --max-time 10 -X "$1" -H "$3" "$2" 2>"$TMP/curl.err")
  else
    out=$(curl -s -o "$TMP/body" -w '%{http_code} %{content_type}' --max-time 10 -X "$1" "$2" 2>"$TMP/curl.err")
  fi
  CURL_EXIT=$?; CODE=${out%% *}; CTYPE=${out#* }
}
curl_reason() {
  case "$CURL_EXIT" in
    7) echo "connection refused: nothing is listening on $API" ;;
    28) echo "timed out after 10 s: something is listening but not answering" ;;
    52|56) echo "the connection was closed without a reply (the service crashed or restarted mid-request)" ;;
    6) echo "could not resolve the host name in $API" ;;
    *) echo "curl exit code $CURL_EXIT: $(cat "$TMP/curl.err" 2>/dev/null)" ;;
  esac
}
env_default() { # value of $1 from the environment, else from .env, else $2 (compose reads .env too)
  eval "v=\${$1:-}"
  if [ -z "$v" ] && [ -f .env ]; then v=$(sed -n "s/^$1=//p" .env | tail -n 1 | tr -d "\"'\r"); fi
  echo "${v:-$2}"
}
finish() {
  section "Summary"
  printf '%d passed, %d failed, %d warning(s)\n' "$PASSED" "$FAILED" "$WARNED"
  if [ "$FAILED" -gt 0 ]; then
    printf '%bSMOKE TEST FAILED%b. Failed checks:%s\n' "$R" "$N" "$FAILURES"
    printf 'Each failure above says what happened, why, and how to fix it. Full logs: docker compose logs api db\n'
  else
    printf '%bSMOKE TEST PASSED%b: the service is up and talking to Postgres. API: %s\n' "$G" "$N" "$API"
  fi
  [ "$DOWN" = 1 ] && { docker compose down >/dev/null 2>&1; echo "Stack stopped (docker compose down; data volume kept)."; }
  [ "$FAILED" -eq 0 ]
  exit $?
}

API_PORT=$(env_default API_PORT 3480)
DB_PORT=$(env_default DB_PORT 15432)
API="http://localhost:$API_PORT"

# ---------- 1. prerequisites --------------------------------------------------------------------
section "1. Prerequisites"
printf 'Host: %s\n' "$(uname -srm 2>/dev/null || echo unknown)"

if ! command -v curl >/dev/null 2>&1; then
  fail "curl is installed" "the curl command was not found" "curl is not installed" \
    "install it (Debian/Ubuntu: sudo apt install curl; Fedora: sudo dnf install curl; macOS has it)"
  finish
fi
pass "curl is installed"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is installed" "the docker command was not found on PATH" \
    "Docker is not installed, or (Windows) this shell cannot see it" \
    "Linux: install Docker Engine (https://docs.docker.com/engine/install/). macOS/Windows: install Docker Desktop. Windows with Docker inside WSL: run this script inside WSL (wsl sh scripts/smoke.sh)."
  finish
fi
pass "docker is installed ($(docker --version 2>/dev/null | sed 's/^Docker version //'))"

if ! docker info >"$TMP/info.log" 2>&1; then
  if grep -qi 'permission denied' "$TMP/info.log"; then
    fail "docker daemon is reachable" "docker could not talk to the daemon: permission denied on its socket" \
      "your user is not in the 'docker' group" \
      "run: sudo usermod -aG docker \$USER, then log out and back in (or run: newgrp docker). Using sudo for every command also works." "$TMP/info.log"
  else
    fail "docker daemon is reachable" "docker is installed but the daemon did not answer" \
      "the Docker daemon is not running" \
      "Linux: sudo systemctl start docker (WSL without systemd: sudo service docker start). Docker Desktop: start the app and wait until it says it is running." "$TMP/info.log"
  fi
  finish
fi
pass "docker daemon is reachable"

if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then why="only the old standalone docker-compose (v1) is installed; this project needs the 'docker compose' plugin (v2)"
  else why="the Docker Compose plugin is not installed"; fi
  fail "docker compose v2 is available" "'docker compose version' failed" "$why" \
    "Debian/Ubuntu: sudo apt install docker-compose-plugin (or docker-compose-v2). Fedora: sudo dnf install docker-compose-plugin. Docker Desktop includes it."
  finish
fi
pass "docker compose v2 is available ($(docker compose version --short 2>/dev/null))"

# ---------- 2. start the stack ------------------------------------------------------------------
section "2. Start the stack (docker compose up ${BUILD:+--build }-d --wait)"
echo "Building and starting db + api; the first run downloads images and can take a few minutes..."
if docker compose up $BUILD -d --wait >"$TMP/up.log" 2>&1; then
  pass "db and api containers are up and healthy"
else
  if grep -qiE 'port is already allocated|address already in use|only one usage of each socket' "$TMP/up.log"; then
    port=$(grep -iE 'port is already allocated|address already in use|only one usage of each socket' "$TMP/up.log" \
      | grep -oE '[0-9a-f.:\[\]]*:[0-9]+' | grep -oE '[0-9]+$' | head -n 1)
    case "$port" in
      "$API_PORT") var=API_PORT; svc="the API (api)" ;;
      "$DB_PORT") var=DB_PORT; svc="Postgres (db)" ;;
      *) var="API_PORT or DB_PORT"; svc="one of the services" ;;
    esac
    holder=""
    if [ -n "$port" ] && command -v ss >/dev/null 2>&1; then holder=$(ss -ltnp 2>/dev/null | grep ":$port " | head -n 1); fi
    if [ -z "$holder" ] && [ -n "$port" ] && command -v lsof >/dev/null 2>&1; then holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sed -n 2p); fi
    fail "host ports are free" "host port ${port:-?} for $svc is already taken by another program${holder:+ ($holder)}" \
      "another service on this machine (often a local Postgres, another dev server, or a second copy of this stack) is listening on that port" \
      "stop that program, or pick another port: $var=<free port> sh scripts/smoke.sh (or put $var=<port> in .env; docker compose reads it). Then use that port in the URLs." "$TMP/up.log"
  elif grep -qi "unknown flag: --wait" "$TMP/up.log"; then
    fail "docker compose supports --wait" "this Compose version does not know the --wait flag" "Docker Compose is older than v2.1" \
      "update the Compose plugin (sudo apt install docker-compose-plugin) or Docker Desktop" "$TMP/up.log"
  elif grep -qiE 'no space left on device' "$TMP/up.log"; then
    fail "image builds" "Docker ran out of disk space" "old images/build cache fill the disk" \
      "free space: docker system prune (add -a to also drop unused images), then re-run" "$TMP/up.log"
  elif grep -qiE 'pull access denied|TLS handshake|no such host|dial tcp|i/o timeout|toomanyrequests' "$TMP/up.log"; then
    fail "base images download" "Docker could not download an image (postgres:17-alpine or node:24-alpine)" \
      "no internet access, a proxy/firewall, or Docker Hub rate limiting" \
      "check connectivity (docker pull postgres:17-alpine); behind a proxy configure it for the Docker daemon; on rate limits run docker login or wait" "$TMP/up.log"
  elif grep -qiE 'failed to solve|ERR_PNPM|error TS[0-9]' "$TMP/up.log"; then
    fail "api image builds" "building the service image failed" \
      "a dependency install or TypeScript compile step failed inside the Dockerfile (see evidence)" \
      "read the evidence below; if a network step failed, re-run. If it says the lockfile is out of date, the repo is inconsistent; report it." "$TMP/up.log"
  else
    # Containers started but did not become healthy: find which one and read its logs.
    docker compose ps -a >"$TMP/ps.log" 2>&1
    dblog=$(logs_of db); apilog=$(logs_of api)
    if grep -qiE 'database files are incompatible|initialized by PostgreSQL version' "$dblog"; then
      fail "db container is healthy" "Postgres refused to start on its existing data volume" \
        "the volume was created by a different Postgres major version (an older checkout of this stack)" \
        "drop the old dev data: docker compose down -v, then re-run (this deletes only this stack's dev database)" "$dblog"
    elif ! grep -q 'database system is ready to accept connections' "$dblog"; then
      fail "db container is healthy" "the Postgres container did not become ready" \
        "Postgres failed during start-up (see its log below)" \
        "fix what the log says; if it is a corrupt or stale volume: docker compose down -v and re-run" "$dblog"
    elif grep -qiE 'ConfigError|invalid environment' "$apilog"; then
      fail "api container is healthy" "the service rejected its configuration at start-up" \
        "an environment variable (from .env or the shell) has an invalid value; the log names it and the fix" \
        "correct that variable (compare with .env.example), then re-run" "$apilog"
    elif grep -qiE 'migration.*fail|failed to migrate' "$apilog"; then
      fail "api container is healthy" "database migrations failed when the service started" \
        "a migration errored against this database (see log)" \
        "read the error; for a throwaway dev DB: docker compose down -v and re-run" "$apilog"
    elif grep -qiE 'ECONNREFUSED|password authentication failed|ENOTFOUND' "$apilog"; then
      fail "api container is healthy" "the service could not connect to Postgres" \
        "wrong DATABASE_URL override, or the db container is not on the same network" \
        "remove any DATABASE_URL override for the container (compose sets postgres://app:app@db:5432/app) and re-run" "$apilog"
    else
      fail "containers become healthy" "docker compose up did not finish with every container healthy" \
        "see the compose output and container states below" \
        "inspect: docker compose ps -a; docker compose logs api db" "$TMP/up.log"
      sed 's/^/        | /' "$TMP/ps.log"
      echo "      api log:"; tail -n 15 "$apilog" | sed 's/^/        | /'
    fi
  fi
  finish
fi

# The real published port (handles overrides in .env or the shell).
real=$(docker compose port api 3000 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)
[ -n "$real" ] && API_PORT=$real && API="http://localhost:$API_PORT"
printf 'API published at %s · Postgres at localhost:%s\n' "$API" "$(docker compose port db 5432 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)"

# ---------- 3. the service answers --------------------------------------------------------------
section "3. Service answers on the host"
http GET "$API/health"
if [ "$CURL_EXIT" -ne 0 ]; then
  fail "GET /health" "$(curl_reason)" \
    "the api container is up but its port is not reachable from this host (port mapping, firewall, or the service stopped)" \
    "check: docker compose ps (PORTS column should show $API_PORT->3000) and docker compose logs api" "$(logs_of api)"
  finish
elif [ "$CODE" = 200 ]; then pass "GET /health -> 200 (service is alive)"
else fail "GET /health" "got HTTP $CODE instead of 200" "something else answers on port $API_PORT, or the service is failing" \
  "check that $API is this stack (docker compose ps) and read docker compose logs api" "$TMP/body"; fi

# ---------- 4. the service talks to the database ------------------------------------------------
section "4. Service <-> database round trip (GET /health/db)"
http GET "$API/health/db"
if [ "$CODE" = 200 ] && [ "$(jfield status "$TMP/body")" = ok ]; then
  pass "GET /health/db -> 200: service ran a real query on Postgres $(jfield serverVersion "$TMP/body") (database \"$(jfield database "$TMP/body")\", $(jfield latencyMs "$TMP/body") ms)"
  if grep -q '"pending":\[\]' "$TMP/body"; then pass "all migrations applied (latest: $(jfield latest "$TMP/body"))"
  else fail "migrations applied" "the service reports pending migrations" "MIGRATE_ON_START is off or a migration was skipped" \
    "run migrations (MIGRATE_ON_START=true is the compose default) and check docker compose logs api" "$TMP/body"; fi
elif [ "$CODE" = 503 ]; then
  fail "GET /health/db" "the service is running but reports the database unreachable: $(jfield detail "$TMP/body")" \
    "Postgres is down, restarting, or the service points at the wrong database" \
    "the service's own advice: $(jfield fix "$TMP/body"). Also check: docker compose ps db" "$(logs_of db)"
else
  fail "GET /health/db" "expected 200, got ${CODE:-no response} ($(curl_reason))" "the service is failing on its database check" \
    "read docker compose logs api (search for the x-request-id)" "$(logs_of api)"
fi

# ---------- 5. error contract -------------------------------------------------------------------
section "5. Errors explain themselves"
http GET "$API/definitely-not-a-route"
if [ "$CODE" = 404 ] && echo "$CTYPE" | grep -q 'application/problem+json' && grep -q '"fix"' "$TMP/body"; then
  pass "unknown route -> 404 problem+json with a reason and a fix"
else
  fail "unknown route returns problem+json" "got HTTP $CODE, content-type '$CTYPE'" "the error handler is not registered, or another server answers on $API_PORT" \
    "confirm $API is this stack; then see packages/service/src/http/errors.ts" "$TMP/body"
fi

# ---------- 6. API test mode --------------------------------------------------------------------
section "6. API test mode (isolated database per session)"
http POST "$API/_test/sessions"
if [ "$CODE" = 404 ]; then
  warn "test mode is disabled on this stack (TEST_SESSIONS_ENABLED=false); skipping its checks" \
    "That is the right setting where real data lives. The compose default enables it for dev/demo."
elif [ "$CODE" = 201 ]; then
  sid=$(jfield id "$TMP/body")
  pass "POST /_test/sessions -> 201 (session $sid)"
  http GET "$API/health/db" "x-test-session: $sid"
  if [ "$CODE" = 200 ] && [ "$(jfield database "$TMP/body")" = "$sid" ]; then pass "requests with x-test-session run on the session's own database"
  else fail "x-test-session routes to the session DB" "expected database \"$sid\", got HTTP $CODE database \"$(jfield database "$TMP/body")\"" \
    "the session could not be resolved" "check docker compose logs api for 'test session'" "$TMP/body"; fi
  http GET "$API/health/db" "x-test-session;" # curl syntax for "send this header with an empty value"
  if [ "$CODE" = 400 ] && [ "$(jfield code "$TMP/body")" = TEST_SESSION_INVALID ]; then pass "a blank x-test-session is refused (never falls through to real data)"
  else fail "blank x-test-session is refused" "expected 400 TEST_SESSION_INVALID, got HTTP $CODE" \
    "an older image without the blank-header guard" "rebuild: sh scripts/smoke.sh (without --no-build)" "$TMP/body"; fi
  http DELETE "$API/_test/sessions/$sid"
  if [ "$CODE" = 204 ]; then pass "DELETE /_test/sessions/:id -> 204"
  else fail "session delete" "expected 204, got HTTP $CODE" "see body" "check docker compose logs api" "$TMP/body"; fi
else
  fail "POST /_test/sessions" "expected 201, got HTTP ${CODE:-no response}" \
    "the service could not create a session database (permissions, or the session cap was reached)" \
    "the body below has the reason and fix; also docker compose logs api" "$TMP/body"
fi

# ---------- 7. optional: database outage and recovery -------------------------------------------
if [ "$FAILOVER" = 1 ]; then
  section "7. Database outage and recovery (--failover)"
  trap 'docker compose start db >/dev/null 2>&1; rm -rf "$TMP"' EXIT
  docker compose stop db >/dev/null 2>&1
  got=""; i=0
  while [ $i -lt 15 ]; do http GET "$API/health/db"; [ "$CODE" = 503 ] && { got=1; break; }; i=$((i + 1)); sleep 1; done
  if [ -n "$got" ]; then pass "DB stopped -> /health/db answers 503 with reason: $(jfield detail "$TMP/body")"
  else fail "outage is reported" "with the DB stopped, /health/db answered HTTP $CODE instead of 503" \
    "the health check does not reach the database, or a different DB is configured" "read docker compose logs api" "$TMP/body"; fi
  docker compose start db >/dev/null 2>&1
  got=""; i=0
  while [ $i -lt 60 ]; do http GET "$API/health/db"; [ "$CODE" = 200 ] && { got=1; break; }; i=$((i + 1)); sleep 1; done
  if [ -n "$got" ]; then pass "DB restarted -> service recovered on its own (no api restart) after ~${i} s"
  else fail "service recovers" "60 s after restarting the DB, /health/db still answers HTTP $CODE" \
    "the connection pool is not reconnecting, or Postgres failed to restart" "docker compose ps; docker compose logs db api" "$(logs_of db)"; fi
fi

finish
