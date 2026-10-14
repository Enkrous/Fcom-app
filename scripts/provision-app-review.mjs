// Non-destructive production fixture: four approved members in an isolated
// test school and six direct messages. Never imports supabase/seed.sql.
import pg from 'pg';
import { randomUUID, randomBytes, pbkdf2Sync } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const outputPath = option('--credentials-file');
if (!outputPath || (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_PASSWORD)) {
  console.error('Set DATABASE_URL or SUPABASE_DB_PASSWORD and pass --credentials-file <private output path>.');
  process.exit(1);
}
const projectRef = process.env.SUPABASE_PROJECT_REF;
if (!process.env.DATABASE_URL && !projectRef) {
  console.error('SUPABASE_PROJECT_REF is required when using SUPABASE_DB_PASSWORD.');
  process.exit(1);
}
const client = new pg.Client(process.env.DATABASE_URL ? {
  connectionString: process.env.DATABASE_URL,
} : {
  host: `db.${projectRef}.supabase.co`, port: 5432, database: 'postgres', user: 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: true },
});
const school = process.env.APP_REVIEW_SCHOOL || 'Fcom App Review';
const prefix = process.env.APP_REVIEW_NICKNAME || `review_${randomBytes(5).toString('hex')}`;
const credentials = { nickname: prefix, password: randomBytes(18).toString('base64url'), school };
const passwordHash = (password) => {
  const salt = randomBytes(16);
  return `pbkdf2:sha256:100000:${salt.toString('hex')}:${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')}`;
};
let file;
let connected = false;
let committed = false;
try {
  // Refuse overwriting an existing credential file; establish writability before
  // touching the database. Credentials never appear in terminal or Git output.
  file = await open(path.resolve(outputPath), 'wx', 0o600);
  await client.connect();
  connected = true;
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`app-review:${prefix}`]);
  const users = [];
  for (let index = 0; index < 4; index++) {
    const id = randomUUID();
    const nickname = index === 0 ? prefix : `${prefix}_peer${index}`;
    const password = index === 0 ? credentials.password : randomBytes(18).toString('base64url');
    await client.query(`INSERT INTO public.users
      (id, "fullName", school, grade, nickname, "passwordHash", "phoneVerified", role, status, cred)
      VALUES ($1, $2, $3, 'Review', $4, $5, false, 'member', 'approved', 1)`,
    [id, index === 0 ? `App Review ${prefix}` : `Review Participant ${index} ${prefix}`, school, nickname, passwordHash(password)]);
    users.push({ id, nickname });
  }
  for (let index = 1; index < users.length; index++) {
    await client.query(`INSERT INTO public.messages ("fromId", "toId", text, time)
      VALUES ($1, $2, 'Welcome to the App Review test conversation.', now() - interval '2 minutes'),
             ($2, $1, 'Thanks! This conversation is ready for review.', now() - interval '1 minute')`,
    [users[0].id, users[index].id]);
  }
  await file.writeFile(JSON.stringify({ ...credentials, userId: users[0].id, participants: users.slice(1) }, null, 2));
  await file.sync();
  await client.query('COMMIT');
  committed = true;
  console.log(`Created an approved App Review account with three conversations. Credentials saved to ${path.resolve(outputPath)}.`);
} catch (error) {
  if (connected && !committed) await client.query('ROLLBACK').catch(() => {});
  console.error(`App Review provisioning failed: ${error.code || error.name}. No existing users were modified.`);
  process.exitCode = 1;
} finally {
  if (file) {
    await file.close();
    if (!committed) await unlink(path.resolve(outputPath));
  }
  if (connected) await client.end();
}
