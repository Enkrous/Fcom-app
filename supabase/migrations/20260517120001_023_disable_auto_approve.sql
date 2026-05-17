CREATE OR REPLACE FUNCTION public.auto_approve_first()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.auto_approve_first()
  IS 'Legacy trigger kept as a no-op. New users stay pending until approved by an admin.';
