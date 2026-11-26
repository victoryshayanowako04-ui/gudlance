-- Persistent rate limiting for the public-facing, custom-authenticated Vault Edge Function.
-- Keys are SHA-256 hashes of the user/IP tuple or IP alone; raw IP addresses are never stored.

CREATE TABLE IF NOT EXISTS public.vault_auth_throttle (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vault_auth_throttle_updated_at_idx
  ON public.vault_auth_throttle (updated_at);

ALTER TABLE public.vault_auth_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_auth_throttle FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vault_auth_throttle FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vault_auth_throttle TO service_role;

COMMENT ON TABLE public.vault_auth_throttle IS
  'Stores hashed, short-lived Vault authentication rate-limit buckets. No raw IP addresses or passwords are stored.';

CREATE OR REPLACE FUNCTION public.consume_vault_auth_attempt(
  p_key_hash text,
  p_max_attempts integer DEFAULT 6,
  p_window_seconds integer DEFAULT 300,
  p_block_seconds integer DEFAULT 900
)
RETURNS TABLE (
  allowed boolean,
  attempts integer,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row public.vault_auth_throttle%ROWTYPE;
BEGIN
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid Vault throttle key';
  END IF;
  IF p_max_attempts < 2 OR p_max_attempts > 20 OR
     p_window_seconds < 60 OR p_window_seconds > 3600 OR
     p_block_seconds < 60 OR p_block_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid Vault throttle settings';
  END IF;

  INSERT INTO public.vault_auth_throttle AS current_bucket
    (key_hash, window_started_at, attempt_count, blocked_until, updated_at)
  VALUES
    (p_key_hash, v_now, 1, NULL, v_now)
  ON CONFLICT (key_hash) DO UPDATE
  SET
    window_started_at = CASE
      WHEN current_bucket.blocked_until > v_now THEN current_bucket.window_started_at
      WHEN current_bucket.window_started_at <= v_now - make_interval(secs => p_window_seconds) THEN v_now
      ELSE current_bucket.window_started_at
    END,
    attempt_count = CASE
      WHEN current_bucket.blocked_until > v_now THEN current_bucket.attempt_count
      WHEN current_bucket.window_started_at <= v_now - make_interval(secs => p_window_seconds) THEN 1
      ELSE current_bucket.attempt_count + 1
    END,
    blocked_until = CASE
      WHEN current_bucket.blocked_until > v_now THEN current_bucket.blocked_until
      WHEN current_bucket.window_started_at <= v_now - make_interval(secs => p_window_seconds) THEN NULL
      WHEN current_bucket.attempt_count + 1 >= p_max_attempts THEN v_now + make_interval(secs => p_block_seconds)
      ELSE NULL
    END,
    updated_at = v_now
  RETURNING * INTO v_row;

  -- Keep the table bounded without storing personal identifiers.
  DELETE FROM public.vault_auth_throttle
  WHERE updated_at < v_now - interval '1 day'
    AND key_hash <> p_key_hash;

  allowed := v_row.blocked_until IS NULL OR v_row.blocked_until <= v_now;
  attempts := v_row.attempt_count;
  retry_after_seconds := CASE
    WHEN allowed THEN 0
    ELSE GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.blocked_until - v_now)))::integer)
  END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_vault_auth_attempt(p_key_hash text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  DELETE FROM public.vault_auth_throttle WHERE key_hash = p_key_hash;
$$;

REVOKE ALL ON FUNCTION public.consume_vault_auth_attempt(text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_vault_auth_attempt(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_vault_auth_attempt(text, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_vault_auth_attempt(text) TO service_role;
