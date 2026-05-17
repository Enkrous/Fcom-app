ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('member', 'admin'));

CREATE INDEX IF NOT EXISTS users_role_idx ON public.users (role);

COMMENT ON COLUMN public.users.role IS 'member | admin';
