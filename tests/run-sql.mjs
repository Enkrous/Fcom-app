// Real PostgreSQL (WASM) regression checks. Only auth/storage/cron platform
// facilities are stubbed; application tables, triggers, grants and RPCs run
// unchanged. This is a local check, not evidence about a hosted project.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const db = await PGlite.create();
try {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobname text PRIMARY KEY);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint';
    CREATE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  `);
  for (const dir of ['migrations', 'supabase/migrations']) {
    for (const file of (await readdir(path.join(root, dir))).filter(f => f.endsWith('.sql')).sort()) {
      let sql = await readFile(path.join(root, dir, file), 'utf8');
      if (file.startsWith('009_')) {
        sql = sql.replace('CREATE EXTENSION IF NOT EXISTS pg_cron;', '').replace(/COMMENT ON EXTENSION pg_cron IS '[^']*';/, '');
      }
      try { await db.exec(sql); }
      catch (error) { throw new Error(`${dir}/${file}: ${error.message}`, { cause: error }); }
    }
  }
  for (const file of (await readdir(path.join(root, 'tests/sql'))).filter(f => f.endsWith('.sql')).sort()) {
    try { await db.exec(await readFile(path.join(root, 'tests/sql', file), 'utf8')); }
    catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
    console.log(`PASS ${file}`);
  }
} catch (error) {
  console.error(`FAIL SQL checks: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
