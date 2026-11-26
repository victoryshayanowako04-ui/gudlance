-- Restrict the privileged role to the exact operations required by the Vault RPC.
-- The audit table is append-only: no UPDATE, DELETE, TRUNCATE or DDL privileges.
REVOKE ALL ON TABLE public.vault_daily_sessions FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.vault_daily_sessions TO service_role;

REVOKE ALL ON TABLE public.vault_session_audit FROM service_role;
GRANT SELECT, INSERT ON TABLE public.vault_session_audit TO service_role;

REVOKE ALL ON SEQUENCE public.vault_session_audit_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.vault_session_audit_id_seq TO service_role;