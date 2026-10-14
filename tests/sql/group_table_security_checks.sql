-- Service-only public application data security regression checks.
-- Run after migration 032 using an administrative SQL session / psql ON_ERROR_STOP.
-- Read-only for application data: only a temporary result table is created.
-- Includes inherited/table/column privileges, views, sequences, RPCs, schema
-- creation and defaults. Extension-owned objects are outside the app contract.
DROP TABLE IF EXISTS pg_temp.fcom_group_security_checks;
CREATE TEMP TABLE fcom_group_security_checks (
  check_name TEXT PRIMARY KEY, ok BOOLEAN NOT NULL, detail TEXT NOT NULL
);

WITH expected(name) AS (VALUES
  ('users'), ('messages'), ('otp_codes'), ('sessions'), ('rate_log'),
  ('approval_log'), ('device_blocks'), ('rate_limit_log'), ('chat_groups'),
  ('group_members'), ('group_invites'), ('user_reports'), ('user_blocks'),
  ('chat_media_cleanup_queue')
)
INSERT INTO fcom_group_security_checks
SELECT 'required table public.' || name,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = name AND c.relkind IN ('r', 'p')),
  'table must exist before deploying dependent Edge Functions'
FROM expected;

DO $$
DECLARE
  v_rel RECORD;
  v_role RECORD;
  v_routine RECORD;
  v_owner RECORD;
  v_default_kind TEXT;
  v_acl ACLITEM[];
  v_columns BOOLEAN;
  v_grants BOOLEAN;
  v_public BOOLEAN;
  v_service OID := (SELECT oid FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  INSERT INTO fcom_group_security_checks VALUES
    ('required role service_role', v_service IS NOT NULL, 'Edge Function database role');
  FOR v_role IN SELECT r.oid, target.name FROM (VALUES ('anon'), ('authenticated')) target(name)
    LEFT JOIN pg_roles r ON r.rolname = target.name
  LOOP
    INSERT INTO fcom_group_security_checks VALUES ('required role ' || v_role.name,
      v_role.oid IS NOT NULL, 'direct client role');
    INSERT INTO fcom_group_security_checks VALUES ('no schema CREATE for ' || v_role.name,
      CASE WHEN v_role.oid IS NULL THEN false ELSE NOT has_schema_privilege(v_role.oid, 'public', 'CREATE') END,
      'prevent security-definer search path shadowing');
  END LOOP;

  FOR v_rel IN SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relacl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    SELECT EXISTS (SELECT 1 FROM aclexplode(v_rel.relacl) a WHERE a.grantee = 0) INTO v_public;
    INSERT INTO fcom_group_security_checks VALUES ('no PUBLIC object grant on public.' || v_rel.relname,
      NOT v_public, 'all explicit object ACLs including TRUNCATE/REFERENCES/TRIGGER');

    IF v_rel.relkind IN ('r', 'p') THEN
      INSERT INTO fcom_group_security_checks VALUES ('RLS enabled on public.' || v_rel.relname,
        v_rel.relrowsecurity, 'row-level security required for every application table');
      INSERT INTO fcom_group_security_checks
      SELECT 'service-only policies on public.' || v_rel.relname,
        NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = v_rel.oid
          AND (p.polroles <> ARRAY[v_service]::OID[])),
        'no policy for PUBLIC, anon, authenticated or inherited client roles';
    END IF;

    FOR v_role IN SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
      IF v_rel.relkind = 'S' THEN
        v_grants := has_sequence_privilege(v_role.oid, v_rel.oid, 'USAGE, SELECT, UPDATE');
        v_columns := false;
      ELSE
        v_grants := has_table_privilege(v_role.oid, v_rel.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
        v_columns := has_any_column_privilege(v_role.oid, v_rel.oid, 'SELECT, INSERT, UPDATE, REFERENCES');
        -- ACL inspection also covers new PostgreSQL privileges (e.g. MAINTAIN).
        v_grants := v_grants OR EXISTS (SELECT 1 FROM aclexplode(v_rel.relacl) a
          WHERE a.grantee = 0 OR a.grantee = v_role.oid
            OR (a.grantee <> 0 AND pg_has_role(v_role.oid, a.grantee, 'USAGE')));
      END IF;
      INSERT INTO fcom_group_security_checks VALUES
        (v_role.rolname || ' has no object/column access to public.' || v_rel.relname,
          NOT (v_grants OR v_columns), 'effective privileges include inherited and PUBLIC grants');
    END LOOP;

    IF v_rel.relkind <> 'S' THEN
      INSERT INTO fcom_group_security_checks
      SELECT 'no PUBLIC column grants on public.' || v_rel.relname,
        NOT EXISTS (SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
          WHERE att.attrelid = v_rel.oid AND att.attnum > 0 AND a.grantee = 0),
        'table-level REVOKE alone does not remove column-level grants';
      INSERT INTO fcom_group_security_checks VALUES ('service_role read/write on public.' || v_rel.relname,
        COALESCE(has_table_privilege(v_service, v_rel.oid, 'SELECT')
          AND has_table_privilege(v_service, v_rel.oid, 'INSERT')
          AND has_table_privilege(v_service, v_rel.oid, 'UPDATE')
          AND has_table_privilege(v_service, v_rel.oid, 'DELETE'), false), 'Edge Function access retained');
    END IF;
  END LOOP;

  FOR v_routine IN SELECT p.oid, p.oid::regprocedure::TEXT AS identity, p.prosecdef, p.proconfig, p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    INSERT INTO fcom_group_security_checks
    SELECT 'no PUBLIC EXECUTE on ' || v_routine.identity,
      NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(v_routine.proacl,
        acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_routine.oid)))) a WHERE a.grantee = 0),
      'implicit default PUBLIC EXECUTE must also be revoked';
    FOR v_role IN SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
      INSERT INTO fcom_group_security_checks VALUES
        (v_role.rolname || ' cannot execute ' || v_routine.identity,
          NOT has_function_privilege(v_role.oid, v_routine.oid, 'EXECUTE'), 'service-only RPC and trigger routines');
    END LOOP;
    INSERT INTO fcom_group_security_checks VALUES ('service_role can execute ' || v_routine.identity,
      COALESCE(has_function_privilege(v_service, v_routine.oid, 'EXECUTE'), false), 'existing backend RPCs continue working');
    IF v_routine.prosecdef THEN
      INSERT INTO fcom_group_security_checks VALUES ('safe search_path for ' || v_routine.identity,
        COALESCE('search_path=pg_catalog, public, pg_temp' = ANY(v_routine.proconfig)
          OR 'search_path=pg_catalog, pg_temp' = ANY(v_routine.proconfig), false),
        'pg_catalog first; explicit pg_temp last; public CREATE denied to clients');
    END IF;
  END LOOP;

  FOR v_owner IN SELECT DISTINCT r.oid, r.rolname FROM pg_roles r WHERE r.oid IN (
    SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    UNION SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    UNION SELECT oid FROM pg_roles WHERE rolname IN (current_user, 'service_role')
  ) LOOP
    FOREACH v_default_kind IN ARRAY ARRAY['r', 'S', 'f'] LOOP
      SELECT COALESCE((SELECT d.defaclacl FROM pg_default_acl d
        WHERE d.defaclrole = v_owner.oid AND d.defaclnamespace = 0 AND d.defaclobjtype = v_default_kind::"char"),
        acldefault(v_default_kind::"char", v_owner.oid)) INTO v_acl;
      SELECT EXISTS (SELECT 1 FROM aclexplode(v_acl) a WHERE a.grantee = 0 OR a.grantee IN
        (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))) INTO v_grants;
      v_grants := v_grants OR EXISTS (SELECT 1 FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole = v_owner.oid AND d.defaclobjtype = v_default_kind::"char"
          AND d.defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          AND (a.grantee = 0 OR a.grantee IN
            (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))));
      INSERT INTO fcom_group_security_checks VALUES
        ('safe defaults ' || v_owner.rolname || ' type ' || v_default_kind,
          NOT v_grants, 'global + public namespace defaults prevent future accidental client grants');
    END LOOP;
  END LOOP;
END;
$$;

SELECT check_name, ok, detail FROM fcom_group_security_checks ORDER BY ok, check_name;
DO $$
DECLARE failed_checks TEXT;
BEGIN
  SELECT string_agg(check_name || ' => ' || detail, E'\n' ORDER BY check_name)
    INTO failed_checks FROM fcom_group_security_checks WHERE NOT ok;
  IF failed_checks IS NOT NULL THEN
    RAISE EXCEPTION 'Application security checks failed:%', E'\n' || failed_checks;
  END IF;
  RAISE NOTICE 'All application table, column, RPC, sequence and default ACL checks passed.';
END;
$$;
DROP TABLE pg_temp.fcom_group_security_checks;
