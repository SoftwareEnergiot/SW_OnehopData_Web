-- Row Level Security policies for the two tables the environment selection
-- feature reads and writes: `environment` and `payloads_REE`.
--
-- WHY THIS SCRIPT EXISTS
--
-- Both tables already exist and are NOT created here. What they do not have is
-- the access the application needs. Probing the live database with the
-- project's anon key shows both symptoms:
--
--   * neither table appears in the PostgREST schema cache for `anon`, which is
--     what a missing SELECT grant looks like;
--   * an insert into payloads_REE comes back as
--     42501 "new row violates row-level security policy".
--
-- So every read returns zero rows and every insert is rejected. The visible
-- symptoms are an environment selector that says "No environments available"
-- and an REE dataset that looks permanently empty.
--
-- UNTIL THIS SCRIPT IS RUN the environment selector has nothing to offer and
-- the payload endpoints answer 404 "public.environment returned no rows",
-- because the application refuses to invent an environment list.
--
-- The policies below are exactly the ones scripts/001 and scripts/002 already
-- define for `payloads` and `payload_error_codes`. Nothing here is more
-- permissive than what this project already grants; no table is created,
-- dropped, renamed or altered, and no row is inserted.
--
-- Run it once against the database, with the migrations in this directory.

-- ---------------------------------------------------------------------------
-- public.environment
--
-- The list the environment selector offers. Read-only: environments are
-- managed in the database, never from the application.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.environment TO anon, authenticated;

ALTER TABLE public.environment ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read" ON public.environment;
CREATE POLICY "Allow public read" ON public.environment FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- public."payloads_REE"
--
-- The REE environment's payload dataset. Same access as `payloads`: readable
-- for the dashboard, insertable so the ingestion endpoint can store a report.
--
-- The device-UID restriction on writes is NOT defined here. It is already
-- enforced by the database (a CHECK constraint or an INSERT policy predicate
-- on this table), and the application deliberately does not duplicate,
-- weaken or work around it: a rejected insert is surfaced to the user as the
-- database's own error.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON public."payloads_REE" TO anon, authenticated;
-- The identity column needs its sequence, the same way `payloads` gets one.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

ALTER TABLE public."payloads_REE" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read" ON public."payloads_REE";
CREATE POLICY "Allow public read" ON public."payloads_REE"
  FOR SELECT USING (true);

-- Devices have no session, exactly as for `payloads`. Which device UIDs are
-- accepted stays the database's decision.
DROP POLICY IF EXISTS "Allow public insert" ON public."payloads_REE";
CREATE POLICY "Allow public insert" ON public."payloads_REE"
  FOR INSERT WITH CHECK (true);

-- Per-device lookups and the dashboard's device filter.
CREATE INDEX IF NOT EXISTS "idx_payloads_REE_device_uid"
  ON public."payloads_REE"(device_uid);
-- The list view and every chart order by reception time.
CREATE INDEX IF NOT EXISTS "idx_payloads_REE_created_at"
  ON public."payloads_REE"(created_at);

-- ---------------------------------------------------------------------------
-- Reload the PostgREST schema cache.
--
-- PostgREST keeps an in-memory picture of the tables, columns and privileges it
-- is allowed to expose, and it is that cache — not the database — that decides
-- what the REST API answers. A GRANT alone does not update it, so until it is
-- reloaded `environment` and `payloads_REE` keep answering as if the anon role
-- still had no access to them.
--
-- Supabase installs an event trigger that reloads the cache after DDL, so the
-- CREATE POLICY / CREATE INDEX statements above usually trigger it on their
-- own. This makes it explicit and covers the GRANT-only case. It is a signal,
-- not a query: it returns immediately and the reload lands a moment later.
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
