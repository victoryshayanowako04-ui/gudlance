-- Add persisted verification state to the already-live daily Vault session schema.
-- This is additive: existing financial records and any existing sessions are not rewritten.
ALTER TABLE public.vault_daily_sessions
    ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS exception_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS movement_count integer NOT NULL DEFAULT 0;

DO $constraints$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vault_daily_sessions_exception_count_nonnegative'
          AND conrelid = 'public.vault_daily_sessions'::regclass
    ) THEN
        ALTER TABLE public.vault_daily_sessions
            ADD CONSTRAINT vault_daily_sessions_exception_count_nonnegative CHECK (exception_count >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vault_daily_sessions_movement_count_nonnegative'
          AND conrelid = 'public.vault_daily_sessions'::regclass
    ) THEN
        ALTER TABLE public.vault_daily_sessions
            ADD CONSTRAINT vault_daily_sessions_movement_count_nonnegative CHECK (movement_count >= 0);
    END IF;
END;
$constraints$;

CREATE OR REPLACE FUNCTION public.record_vault_session(
    p_action text,
    p_business_date date,
    p_currency text,
    p_drawer_id text,
    p_opening_float numeric,
    p_expected_closing numeric,
    p_actual_closing numeric,
    p_snapshot jsonb,
    p_actor_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_session public.vault_daily_sessions%ROWTYPE;
    v_previous jsonb;
    v_action text := upper(COALESCE(p_action, ''));
    v_currency text := upper(COALESCE(p_currency, 'USD'));
    v_drawer text := COALESCE(NULLIF(btrim(p_drawer_id), ''), 'main');
BEGIN
    IF p_business_date IS NULL OR p_actor_id IS NULL OR btrim(p_actor_id) = '' THEN
        RAISE EXCEPTION 'Business date and actor are required';
    END IF;
    IF v_currency NOT IN ('USD', 'ZIG') THEN
        RAISE EXCEPTION 'Unsupported Vault currency: %', v_currency;
    END IF;

    IF v_action = 'OPEN' THEN
        IF p_opening_float IS NULL OR p_opening_float < 0 THEN
            RAISE EXCEPTION 'Opening float must be zero or greater';
        END IF;

        INSERT INTO public.vault_daily_sessions (
            business_date, currency, drawer_id, opening_float, opened_by
        ) VALUES (
            p_business_date, CASE WHEN v_currency = 'ZIG' THEN 'ZiG' ELSE 'USD' END,
            v_drawer, round(p_opening_float, 2), p_actor_id
        )
        ON CONFLICT (business_date, currency, drawer_id) DO NOTHING
        RETURNING * INTO v_session;

        IF NOT FOUND THEN
            SELECT * INTO v_session
            FROM public.vault_daily_sessions
            WHERE business_date = p_business_date
              AND currency = CASE WHEN v_currency = 'ZIG' THEN 'ZiG' ELSE 'USD' END
              AND drawer_id = v_drawer
            FOR UPDATE;

            IF v_session.opening_float <> round(p_opening_float, 2) THEN
                RAISE EXCEPTION 'An opening float is already recorded for this date. Use an authorised adjustment workflow.';
            END IF;
            RETURN to_jsonb(v_session);
        END IF;

        INSERT INTO public.vault_session_audit (session_id, action, actor_id, new_values)
        VALUES (
            v_session.id, 'OPENED', p_actor_id,
            jsonb_build_object(
                'business_date', p_business_date,
                'currency', v_session.currency,
                'drawer_id', v_drawer,
                'opening_float', v_session.opening_float,
                'status', v_session.status
            )
        );
        RETURN to_jsonb(v_session);
    ELSIF v_action = 'CLOSE' THEN
        IF p_expected_closing IS NULL OR p_actual_closing IS NULL
           OR p_actual_closing < 0 THEN
            RAISE EXCEPTION 'Actual closing balance must be zero or greater';
        END IF;

        SELECT * INTO v_session
        FROM public.vault_daily_sessions
        WHERE business_date = p_business_date
          AND currency = CASE WHEN v_currency = 'ZIG' THEN 'ZiG' ELSE 'USD' END
          AND drawer_id = v_drawer
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Record the opening float before closing the Vault';
        END IF;

        IF v_session.status = 'CLOSED' THEN
            IF v_session.expected_closing = round(p_expected_closing, 2)
               AND v_session.actual_closing = round(p_actual_closing, 2) THEN
                RETURN to_jsonb(v_session);
            END IF;
            RAISE EXCEPTION 'This Vault session is already closed. Reopening requires an authorised correction workflow.';
        END IF;

        v_previous := to_jsonb(v_session);
        UPDATE public.vault_daily_sessions
        SET expected_closing = round(p_expected_closing, 2),
            actual_closing = round(p_actual_closing, 2),
            variance = round(p_actual_closing - p_expected_closing, 2),
            exception_count = GREATEST(COALESCE(NULLIF(p_snapshot->>'exceptionCount', '')::integer, 0), 0),
            movement_count = GREATEST(COALESCE(NULLIF(p_snapshot->>'movementCount', '')::integer, 0), 0),
            is_verified = (
                GREATEST(COALESCE(NULLIF(p_snapshot->>'exceptionCount', '')::integer, 0), 0) = 0
                AND round(p_actual_closing - p_expected_closing, 2) = 0
            ),
            closing_snapshot = COALESCE(p_snapshot, '{}'::jsonb),
            status = 'CLOSED',
            closed_by = p_actor_id,
            closed_at = clock_timestamp()
        WHERE id = v_session.id
        RETURNING * INTO v_session;

        INSERT INTO public.vault_session_audit (
            session_id, action, actor_id, previous_values, new_values
        ) VALUES (
            v_session.id, 'CLOSED', p_actor_id, v_previous, to_jsonb(v_session)
        );
        RETURN to_jsonb(v_session);
    ELSE
        RAISE EXCEPTION 'Unsupported Vault session action';
    END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_vault_session(text, date, text, text, numeric, numeric, numeric, jsonb, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_vault_session(text, date, text, text, numeric, numeric, numeric, jsonb, text)
TO service_role;

COMMENT ON COLUMN public.vault_daily_sessions.is_verified IS
'True only when the physical closing count matches expected cash and the calculation snapshot has no unresolved exceptions.';
COMMENT ON COLUMN public.vault_daily_sessions.exception_count IS
'Number of unresolved calculation exceptions captured when the daily Vault session was closed.';
COMMENT ON COLUMN public.vault_daily_sessions.movement_count IS
'Number of source financial movements included in the daily closing snapshot.';
