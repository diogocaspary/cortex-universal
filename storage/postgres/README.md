# PostgreSQL + pgvector production projection

This directory is a production storage baseline, not a second semantic authority. The ontology,
SHACL shapes, JSON contracts and policy bundle remain authoritative. `PostgresBrainEngine` is the
executable adapter selected automatically when `CORTEX_DATABASE_URL` is configured. Startup fails
closed when the schema or pgvector extension is absent.

The migration creates full-text, HNSW vector, graph-projection, append-only activity,
agent-session, governed workforce, append-only measured-cost, Guard reservation, and
effect-observation tables.
Row-level security is forced on every tenant-bearing table. Each transaction must set trusted values
derived by the gateway, never copied from an unverified request:

```sql
BEGIN;
SET LOCAL app.tenant_id = 'tenant-verified-by-gateway';
SET LOCAL app.brain_id = 'brain-authorized-for-principal';
SET LOCAL app.allowed_classifications = 'public,internal';
-- parameterized query here
COMMIT;
```

Apply with a vector dimension matching the chosen embedding model:

```sh
psql "$DATABASE_ADMIN_URL" \
  -v embedding_dimensions=1536 \
  -v cortex_runtime_role=cortex_runtime \
  -f storage/postgres/001_init.sql
```

Create `cortex_runtime` (or the name passed above) before the migration. Use a non-owner runtime role
with only the granted privileges, TLS, encrypted backups, connection
pool transaction reset, and restore drills. The table owner bypasses ordinary RLS and must not be the
application role.

The application performs parameterized queries and calls `set_config(..., true)` inside every
tenant transaction. Do not grant `BYPASSRLS`, superuser, schema ownership, table ownership, trigger
alteration, or migration privileges to the runtime role. Run the adapter integration tests against
the same PostgreSQL/pgvector major versions used in production.
