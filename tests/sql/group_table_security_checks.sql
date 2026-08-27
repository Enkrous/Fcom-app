-- Fcom group and safety table security regression checks.
--
-- Run after applying the group-table hardening and safety migrations.
-- Expected result: every row in the result set has ok = true. The DO block
-- raises an exception at the end if any check fails, which makes this usable
-- from psql with ON_ERROR_STOP=1.

DROP TABLE IF EXISTS pg_temp.fcom_group_security_checks;

CREATE TEMP TABLE fcom_group_security_checks (
  check_name TEXT PRIMARY KEY,
  ok BOOLEAN NOT NULL,
  detail TEXT NOT NULL
);

WITH target_tables(schema_name, table_name) AS (
  VALUES
    ('public', 'chat_groups'),
    ('public', 'group_members'),
    ('public', 'group_invites'),
    ('public', 'user_reports'),
    ('public', 'user_blocks')
)
INSERT INTO fcom_group_security_checks (check_name, ok, detail)
SELECT
  format('RLS enabled on %I.%I', target.schema_name, target.table_name),
  COALESCE(cls.relrowsecurity, false),
  CASE
    WHEN cls.oid IS NULL THEN 'table_missing'
    WHEN cls.relrowsecurity THEN 'rls_enabled'
    ELSE 'rls_disabled'
  END
FROM target_tables AS target
LEFT JOIN pg_catalog.pg_namespace AS ns
  ON ns.nspname = target.schema_name
LEFT JOIN pg_catalog.pg_class AS cls
  ON cls.relnamespace = ns.oid
 AND cls.relname = target.table_name
 AND cls.relkind IN ('r', 'p');

WITH target_tables(schema_name, table_name) AS (
  VALUES
    ('public', 'chat_groups'),
    ('public', 'group_members'),
    ('public', 'group_invites'),
    ('public', 'user_reports'),
    ('public', 'user_blocks')
),
blocked_roles(role_name) AS (
  VALUES ('anon'), ('authenticated')
),
blocked_privileges(privilege_name) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
)
INSERT INTO fcom_group_security_checks (check_name, ok, detail)
SELECT
  format('%s lacks direct %s on %I.%I', role.role_name, priv.privilege_name, target.schema_name, target.table_name),
  CASE
    WHEN db_role.oid IS NULL THEN false
    WHEN cls.oid IS NULL THEN false
    ELSE NOT pg_catalog.has_table_privilege(db_role.oid, cls.oid, priv.privilege_name)
  END,
  CASE
    WHEN db_role.oid IS NULL THEN 'role_missing'
    WHEN cls.oid IS NULL THEN 'table_missing'
    WHEN pg_catalog.has_table_privilege(db_role.oid, cls.oid, priv.privilege_name) THEN 'direct_privilege_present'
    ELSE 'direct_privilege_absent'
  END
FROM target_tables AS target
CROSS JOIN blocked_roles AS role
CROSS JOIN blocked_privileges AS priv
LEFT JOIN pg_catalog.pg_roles AS db_role
  ON db_role.rolname = role.role_name
LEFT JOIN pg_catalog.pg_namespace AS ns
  ON ns.nspname = target.schema_name
LEFT JOIN pg_catalog.pg_class AS cls
  ON cls.relnamespace = ns.oid
 AND cls.relname = target.table_name
 AND cls.relkind IN ('r', 'p');

WITH target_tables(schema_name, table_name) AS (
  VALUES
    ('public', 'chat_groups'),
    ('public', 'group_members'),
    ('public', 'group_invites'),
    ('public', 'user_reports'),
    ('public', 'user_blocks')
),
service_privileges(privilege_name) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
)
INSERT INTO fcom_group_security_checks (check_name, ok, detail)
SELECT
  format('service_role has %s on %I.%I', priv.privilege_name, target.schema_name, target.table_name),
  CASE
    WHEN service_role.oid IS NULL THEN false
    WHEN cls.oid IS NULL THEN false
    ELSE pg_catalog.has_table_privilege(service_role.oid, cls.oid, priv.privilege_name)
  END,
  CASE
    WHEN service_role.oid IS NULL THEN 'role_missing'
    WHEN cls.oid IS NULL THEN 'table_missing'
    WHEN pg_catalog.has_table_privilege(service_role.oid, cls.oid, priv.privilege_name) THEN 'service_role_privilege_present'
    ELSE 'service_role_privilege_missing'
  END
FROM target_tables AS target
CROSS JOIN service_privileges AS priv
LEFT JOIN pg_catalog.pg_roles AS service_role
  ON service_role.rolname = 'service_role'
LEFT JOIN pg_catalog.pg_namespace AS ns
  ON ns.nspname = target.schema_name
LEFT JOIN pg_catalog.pg_class AS cls
  ON cls.relnamespace = ns.oid
 AND cls.relname = target.table_name
 AND cls.relkind IN ('r', 'p');

WITH target_policies(schema_name, table_name, policy_name) AS (
  VALUES
    ('public', 'chat_groups', 'chat_groups_service_role_all'),
    ('public', 'group_members', 'group_members_service_role_all'),
    ('public', 'group_invites', 'group_invites_service_role_all'),
    ('public', 'user_reports', 'user_reports_service_role_all'),
    ('public', 'user_blocks', 'user_blocks_service_role_all')
)
INSERT INTO fcom_group_security_checks (check_name, ok, detail)
SELECT
  format('service_role FOR ALL policy on %I.%I', target.schema_name, target.table_name),
  CASE
    WHEN service_role.oid IS NULL THEN false
    WHEN cls.oid IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = cls.oid
        AND policy.polname = target.policy_name
        AND policy.polcmd = '*'
        AND service_role.oid = ANY(policy.polroles)
    )
  END,
  CASE
    WHEN service_role.oid IS NULL THEN 'role_missing'
    WHEN cls.oid IS NULL THEN 'table_missing'
    WHEN EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = cls.oid
        AND policy.polname = target.policy_name
        AND policy.polcmd = '*'
        AND service_role.oid = ANY(policy.polroles)
    ) THEN 'service_role_policy_present'
    ELSE 'service_role_policy_missing'
  END
FROM target_policies AS target
LEFT JOIN pg_catalog.pg_roles AS service_role
  ON service_role.rolname = 'service_role'
LEFT JOIN pg_catalog.pg_namespace AS ns
  ON ns.nspname = target.schema_name
LEFT JOIN pg_catalog.pg_class AS cls
  ON cls.relnamespace = ns.oid
 AND cls.relname = target.table_name
 AND cls.relkind IN ('r', 'p');

WITH target_tables(schema_name, table_name) AS (
  VALUES
    ('public', 'chat_groups'),
    ('public', 'group_members'),
    ('public', 'group_invites'),
    ('public', 'user_reports'),
    ('public', 'user_blocks')
)
INSERT INTO fcom_group_security_checks (check_name, ok, detail)
SELECT
  format('no anon/authenticated RLS policies on %I.%I', target.schema_name, target.table_name),
  CASE
    WHEN cls.oid IS NULL THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = cls.oid
        AND (
          0::OID = ANY(policy.polroles)
          OR anon_role.oid = ANY(policy.polroles)
          OR authenticated_role.oid = ANY(policy.polroles)
        )
    )
  END,
  CASE
    WHEN cls.oid IS NULL THEN 'table_missing'
    WHEN EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = cls.oid
        AND (
          0::OID = ANY(policy.polroles)
          OR anon_role.oid = ANY(policy.polroles)
          OR authenticated_role.oid = ANY(policy.polroles)
        )
    ) THEN 'direct_client_policy_present'
    ELSE 'direct_client_policy_absent'
  END
FROM target_tables AS target
LEFT JOIN pg_catalog.pg_roles AS anon_role
  ON anon_role.rolname = 'anon'
LEFT JOIN pg_catalog.pg_roles AS authenticated_role
  ON authenticated_role.rolname = 'authenticated'
LEFT JOIN pg_catalog.pg_namespace AS ns
  ON ns.nspname = target.schema_name
LEFT JOIN pg_catalog.pg_class AS cls
  ON cls.relnamespace = ns.oid
 AND cls.relname = target.table_name
 AND cls.relkind IN ('r', 'p');

SELECT check_name, ok, detail
FROM fcom_group_security_checks
ORDER BY ok ASC, check_name ASC;

DO $$
DECLARE
  failed_checks TEXT;
BEGIN
  SELECT string_agg(check_name || ' => ' || detail, E'\n' ORDER BY check_name)
    INTO failed_checks
  FROM fcom_group_security_checks
  WHERE NOT ok;

  IF failed_checks IS NOT NULL THEN
    RAISE EXCEPTION 'Group and safety table security regression checks failed:%', E'\n' || failed_checks;
  END IF;

  RAISE NOTICE 'Group and safety table security regression checks passed.';
END
$$;

DROP TABLE IF EXISTS pg_temp.fcom_group_security_checks;
