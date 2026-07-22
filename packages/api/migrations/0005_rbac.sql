-- Ratchet Phase 3: RBAC. Roles attach to API keys; authorization is enforced at the app layer,
-- above the RLS tenant boundary (ADR-005: RBAC sits above RLS). Roles: operator, admin, integrator.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'integrator';
ALTER TABLE api_keys ADD CONSTRAINT api_keys_role_chk
  CHECK (role IN ('operator', 'admin', 'integrator'));

-- Auth lookup now returns the tenant AND the role for the key (still SECURITY DEFINER: it must
-- resolve across tenants before any tenant context is set — ADR-005 rule 5).
DROP FUNCTION IF EXISTS ratchet_authenticate(text);
CREATE FUNCTION ratchet_authenticate(p_key_hash text)
RETURNS TABLE (tenant_id uuid, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, role FROM api_keys WHERE key_hash = p_key_hash;
$$;
GRANT EXECUTE ON FUNCTION ratchet_authenticate(text) TO ratchet_app;
