// Read-only live schema/ACL checks. No application seed or fixture mutations.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const projectRef = process.env.SUPABASE_PROJECT_REF;
if (!process.env.DATABASE_URL && !(projectRef && process.env.SUPABASE_DB_PASSWORD)) {
  console.error('Set DATABASE_URL or SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD.');
  process.exit(1);
}
const client = new pg.Client(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
  host: `db.${projectRef}.supabase.co`, port: 5432, database: 'postgres', user: 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: true },
});
try {
  await client.connect();
  const sql = await readFile(new URL('../tests/sql/group_table_security_checks.sql', import.meta.url), 'utf8');
  const result = await client.query(sql);
  const checks = (Array.isArray(result) ? result : [result]).flatMap(item => item.rows || []).filter(row => 'check_name' in row);
  console.log(`PASS live RLS/grants: ${checks.length} checks`);
  const { rows } = await client.query(`SELECT
    to_regclass('public.user_blocks') IS NOT NULL AS blocks_028,
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='user_reports_one_open_per_pair') AS reports_029,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='user_reports' AND column_name='targetMessageId') AS message_report_030,
    to_regprocedure('public.delete_account_preserving_groups(uuid)') IS NOT NULL AS deletion_031,
    to_regprocedure('public.consume_rate_limit(text,integer,integer)') IS NOT NULL AS quota_033`);
  console.log(JSON.stringify(rows[0]));
  if (Object.values(rows[0]).some(value => value !== true)) throw new Error('required_schema_missing');
} catch (error) {
  console.error(`Live verification failed: ${error.code || error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
