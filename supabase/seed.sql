-- supabase/seed.sql
-- Development / staging seed data for Fcom / Кредо.
-- Never run this file in production.
--
-- Purpose: provides a ready-to-use set of users, messages, and ratings so that
-- every feature can be exercised immediately after running migrations.
--
-- HOW TO USE
--   Supabase CLI:  supabase db reset        (applies migrations + this seed)
--   SQL Editor:    paste & run only after the required schema migrations are applied
--   Production:    DO NOT run — this truncates/deletes data and inserts fixed test users
--
-- PASSWORDS
--   All seed users use the same password: testpass
--   Hash format matches supabase/functions/_shared/bcrypt.ts (PBKDF2-SHA256).
--   This keeps Postman and TESTING.md reproducible after `supabase db reset`.
--
-- NOTES
--   - UUIDs are hard-coded so relations stay consistent across resets.
--   - status = 'approved' users can log in immediately with `testpass`.
--   - pending / rejected users also have `testpass` set so login tests can reach
--     `account_not_approved` / `account_rejected` instead of `invalid_credentials`.
--   - auto_approve_first() is a legacy no-op; first users are not auto-approved.
--   - Seed users define approved/pending/rejected status directly for tests.
--
-- Shared password hash for all seed users:
--   pbkdf2:sha256:100000:00112233445566778899aabbccddeeff:06e45b9c137301bebfcda22ef6eb7cf350888f0df7153071d0e7654df0b68a8b

-- ─── Clean slate (re-runnable) ──────────────────────────────────────────────

TRUNCATE public.rate_log     RESTART IDENTITY CASCADE;
TRUNCATE public.messages     RESTART IDENTITY CASCADE;
TRUNCATE public.approval_log RESTART IDENTITY CASCADE;
TRUNCATE public.otp_codes    RESTART IDENTITY CASCADE;
TRUNCATE public.sessions     RESTART IDENTITY CASCADE;
TRUNCATE public.device_blocks RESTART IDENTITY CASCADE;
TRUNCATE public.rate_limit_log RESTART IDENTITY CASCADE;
-- users last because other tables reference it
DELETE FROM public.users;

-- ─── Seed users ─────────────────────────────────────────────────────────────
-- IDs are stable so you can reference them in scripts / Postman collections.

INSERT INTO public.users (
  id, "fullName", school, grade, nickname, phone, "phoneVerified",
  "passwordHash", status, cred, "createdAt"
) VALUES

-- School: Школа №1
-- Alice — admin-like approved user, high cred
(
  '00000000-0000-0000-0000-000000000001',
  'Иванова Алиса Сергеевна',
  'Школа №1', '11А', 'alice',
  '+79001000001', true,
  'pbkdf2:sha256:100000:00112233445566778899aabbccddeeff:06e45b9c137301bebfcda22ef6eb7cf350888f0df7153071d0e7654df0b68a8b',
  'approved', 42.50,
  now() - interval '30 days'
),
-- Bob — approved, medium cred
(
  '00000000-0000-0000-0000-000000000002',
  'Петров Борис Иванович',
  'Школа №1', '10Б', 'bob',
  '+79001000002', true,
  'pbkdf2:sha256:100000:00112233445566778899aabbccddeeff:06e45b9c137301bebfcda22ef6eb7cf350888f0df7153071d0e7654df0b68a8b',
  'approved', 18.00,
  now() - interval '20 days'
),
-- Carol — approved, low cred
(
  '00000000-0000-0000-0000-000000000003',
  'Сидорова Карина Олеговна',
  'Школа №1', '9В', 'carol',
  NULL, false,
  'pbkdf2:sha256:100000:00112233445566778899aabbccddeeff:06e45b9c137301bebfcda22ef6eb7cf350888f0df7153071d0e7654df0b68a8b',
  'approved', 5.75,
  now() - interval '10 days'
),
-- Dave — pending (awaiting approval)
(
  '00000000-0000-0000-0000-000000000004',
  'Козлов Дмитрий Александрович',
  'Школа №1', '9В', 'dave',
  '+79001000004', false,
  'pbkdf2:sha256:100000:00112233445566778899aabbccddeeff:06e45b9c137301bebfcda22ef6eb7cf350888f0df7153071d0e7654df0b68a8b',
  'pending', 0,
  now() - interval '1 day'
),
-- Eve — rejected
(
  '00000000-0000-0000-0000-000000000005',
  'Новикова Евгения Петровна',
  'Школа №1', '10А', 'eve',
  '+79001000005', true,
  'pbkdf2:sha256:100000:00112233445566778899aabbccddeeff:06e45b9c137301bebfcda22ef6eb7cf350888f0df7153071d0e7654df0b68a8b',
  'rejected', 0,
  now() - interval '5 days'
),

-- School: Школа №2  (separate school — isolated community)
-- Frank — approved seed user at school №2
(
  '00000000-0000-0000-0000-000000000006',
  'Орлов Фёдор Николаевич',
  'Школа №2', '11Б', 'frank',
  NULL, false,
  'pbkdf2:sha256:100000:00112233445566778899aabbccddeeff:06e45b9c137301bebfcda22ef6eb7cf350888f0df7153071d0e7654df0b68a8b',
  'approved', 1,
  now() - interval '15 days'
),
-- Grace — pending at school №2
(
  '00000000-0000-0000-0000-000000000007',
  'Зайцева Галина Михайловна',
  'Школа №2', '10А', 'grace',
  '+79002000007', false,
  'pbkdf2:sha256:100000:00112233445566778899aabbccddeeff:06e45b9c137301bebfcda22ef6eb7cf350888f0df7153071d0e7654df0b68a8b',
  'pending', 0,
  now() - interval '2 days'
);

-- ─── Approval log (who approved whom) ───────────────────────────────────────

INSERT INTO public.approval_log ("actorId", "targetId", action, "createdAt")
VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'approved', now() - interval '19 days'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'approved', now() - interval '9 days'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000005', 'rejected', now() - interval '4 days');

-- ─── Messages ────────────────────────────────────────────────────────────────

INSERT INTO public.messages ("fromId", "toId", text, time, "readAt")
VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
   'Привет, Борис! Как дела?', now() - interval '5 days', now() - interval '5 days'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'Привет, всё отлично! Готовишься к олимпиаде?', now() - interval '5 days', now() - interval '5 days'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
   'Да, уже третий день сижу над задачами.', now() - interval '4 days', now() - interval '4 days'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003',
   'Карина, можешь помочь с проектом?', now() - interval '3 days', now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'Конечно! Напиши что именно нужно.', now() - interval '3 days', now() - interval '3 days'),
  -- Unread message (readAt IS NULL) — to test the unread counter
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'Кстати, собираемся в пятницу — ты придёшь?', now() - interval '1 hour', NULL);

-- ─── Rate log (Credo ratings) ────────────────────────────────────────────────
-- Insert via direct INSERT (bypass guard trigger — it only guards UPDATE on users.cred)
-- and update cred manually using the sanctioned apply_cred_delta() function.

INSERT INTO public.rate_log (
  "from", "to", score, weight, "baseDelta", "effectiveDelta", date
) VALUES
  -- Bob rates Alice: score 5, full weight
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   5, 1.00, 1.00, 1.00, now() - interval '18 days'),
  -- Carol rates Alice: score 4
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   4, 0.85, 0.80, 0.68, now() - interval '8 days'),
  -- Alice rates Bob: score 4
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
   4, 1.00, 0.80, 0.80, now() - interval '17 days'),
  -- Alice rates Carol: score 3
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003',
   3, 1.00, 0.40, 0.40, now() - interval '7 days');

-- NOTE: The cred values on seed users above already reflect these ratings.
-- If you re-run with fresh users (cred = 0), call apply_cred_delta() to sync:
--
--   SELECT public.apply_cred_delta('00000000-0000-0000-0000-000000000001', 42.50);
--   SELECT public.apply_cred_delta('00000000-0000-0000-0000-000000000002', 18.00);
--   SELECT public.apply_cred_delta('00000000-0000-0000-0000-000000000003', 5.75);
--
-- (The TRUNCATE at the top resets everything, so the INSERT cred values are canonical.)

-- ─── Verification ────────────────────────────────────────────────────────────

DO $$
DECLARE
  user_count    INT;
  msg_count     INT;
  rate_count    INT;
  approved_cnt  INT;
  pending_cnt   INT;
BEGIN
  SELECT COUNT(*) INTO user_count  FROM public.users;
  SELECT COUNT(*) INTO msg_count   FROM public.messages;
  SELECT COUNT(*) INTO rate_count  FROM public.rate_log;
  SELECT COUNT(*) INTO approved_cnt FROM public.users WHERE status = 'approved';
  SELECT COUNT(*) INTO pending_cnt  FROM public.users WHERE status = 'pending';

  RAISE NOTICE '────────────────────────────────────────';
  RAISE NOTICE 'Seed complete:';
  RAISE NOTICE '  Users total  : %', user_count;
  RAISE NOTICE '  Approved     : %', approved_cnt;
  RAISE NOTICE '  Pending      : %', pending_cnt;
  RAISE NOTICE '  Messages     : %', msg_count;
  RAISE NOTICE '  Rate entries : %', rate_count;
  RAISE NOTICE '────────────────────────────────────────';
  RAISE NOTICE 'Test accounts (shared password: testpass):';
  RAISE NOTICE '  alice  — approved, Школа №1, cred 42.50';
  RAISE NOTICE '  bob    — approved, Школа №1, cred 18.00';
  RAISE NOTICE '  carol  — approved, Школа №1, cred  5.75';
  RAISE NOTICE '  dave   — pending,  Школа №1 (approve via alice/bob)';
  RAISE NOTICE '  eve    — rejected, Школа №1';
  RAISE NOTICE '  frank  — approved, Школа №2, cred  1.00';
  RAISE NOTICE '  grace  — pending,  Школа №2 (approve via frank)';
END;
$$;
