# data/

Drop datasets you are given here (`data/raw/` is gitignored). The directory is mounted
read-only into the `db` container at `/data`, so `COPY ... FROM '/data/...'` works from psql.

Load + profile: `pnpm data:load data/raw/<file>` then `pnpm data:profile staging.<table>`.
