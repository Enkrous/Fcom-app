-- Migration 032: application data is accessible through Edge Functions only.
-- Migration 019 left column grants and client policies behind. Revoke those as
-- well as table grants, including ALL privileges, views and sequences. Exclude
-- extension-owned objects so extension upgrades retain their own ACL contracts.
DO $$
DECLARE
  v_relation RECORD;
  v_policy RECORD;
  v_routine RECORD;
  v_owner RECORD;
  v_columns TEXT;
  v_kind TEXT;
BEGIN
  REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

  FOR v_relation IN
    SELECT c.oid, c.relname, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    IF v_relation.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC, anon, authenticated', v_relation.relname);
      EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.%I TO service_role', v_relation.relname);
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_relation.relname);
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_columns
    FROM pg_attribute WHERE attrelid = v_relation.oid AND attnum > 0 AND NOT attisdropped;
    IF v_columns IS NOT NULL THEN
      -- REVOKE ALL ON TABLE does not remove separately granted column ACLs.
      EXECUTE format('REVOKE SELECT (%s), INSERT (%s), UPDATE (%s), REFERENCES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated',
        v_columns, v_columns, v_columns, v_columns, v_relation.relname);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', v_relation.relname);

    IF v_relation.relkind IN ('r', 'p') THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_relation.relname);
      -- The application uses custom JWTs; direct-client policies serve no flow.
      FOR v_policy IN SELECT polname FROM pg_policy WHERE polrelid = v_relation.oid LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_policy.polname, v_relation.relname);
      END LOOP;
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        v_relation.relname || '_service_role_all', v_relation.relname);
    END IF;
  END LOOP;

  FOR v_routine IN
    SELECT p.oid, p.proname, p.prokind, p.prosecdef, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    v_kind := CASE WHEN v_routine.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END;
    EXECUTE format('REVOKE ALL ON %s public.%I(%s) FROM PUBLIC, anon, authenticated', v_kind, v_routine.proname, v_routine.args);
    EXECUTE format('GRANT EXECUTE ON %s public.%I(%s) TO service_role', v_kind, v_routine.proname, v_routine.args);
    IF v_routine.prosecdef THEN
      -- Explicit pg_temp last prevents temporary tables from shadowing public.
      EXECUTE format('ALTER %s public.%I(%s) SET search_path = pg_catalog, public, pg_temp', v_kind, v_routine.proname, v_routine.args);
    END IF;
  END LOOP;

  -- Defaults are per creator role. Cover the migration role and every owner of
  -- existing application objects; fail rather than silently leave an owner open.
  FOR v_owner IN
    SELECT DISTINCT r.oid, r.rolname FROM pg_roles r WHERE r.oid IN (
      SELECT relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      UNION SELECT proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      UNION SELECT oid FROM pg_roles WHERE rolname IN (current_user, 'service_role')
    )
  LOOP
    -- Global default function EXECUTE for PUBLIC is implicit; an IN SCHEMA-only
    -- revoke cannot remove it. Apply both global and public-specific revocations.
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated', v_owner.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated', v_owner.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated', v_owner.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated', v_owner.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated', v_owner.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated', v_owner.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role', v_owner.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO service_role', v_owner.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role', v_owner.rolname);
  END LOOP;
END;
$$;

COMMENT ON SCHEMA public IS 'Fcom: all application tables and RPCs are service_role-only. Clients use Edge Functions with custom JWT authentication. New tables still require ENABLE ROW LEVEL SECURITY.';
