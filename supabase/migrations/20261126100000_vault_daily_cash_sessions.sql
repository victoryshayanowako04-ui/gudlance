-- Daily cash sessions are deliberately separate from legacy financial tables.
-- Existing student, POS, expense and payroll records are never rewritten.
CREATE TABLE IF NOT EXISTS public.vault_daily_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_date date NOT NULL,
    currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'ZiG')),
    drawer_id text NOT NULL DEFAULT 'main',
    opening_float numeric(14,2) NOT NULL CHECK (opening_float >= 0),
    expected_closing numeric(14,2),
    actual_closing numeric(14,2),
    variance numeric(14,2),
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    opened_by text NOT NULL,
    opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_by text,
    closed_at timestamptz,
    closing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (business_date, currency, drawer_id),
    CHECK (actual_closing IS NULL OR actual_closing >= 0)
);

CREATE TABLE IF NOT EXISTS public.vault_session_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES public.vault_daily_sessions(id),
    action text NOT NULL CHECK (action IN ('OPENED', 'CLOSED')),
    actor_id text NOT NULL,
    previous_values jsonb,
    new_values jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.vault_daily_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_daily_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.vault_session_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_session_audit FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vault_daily_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.vault_session_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.vault_daily_sessions TO service_role;
GRANT SELECT, INSERT ON TABLE public.vault_session_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.vault_session_audit_id_seq TO service_role;

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
            RAISE EXCEPTION 'Expected and actual closing balances must be zero or greater';
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

COMMENT ON TABLE public.vault_daily_sessions IS
'Manually opened daily physical cash sessions. Opening float is recorded once and closing is immutable through the standard workflow.';
COMMENT ON TABLE public.vault_session_audit IS
'Append-only audit trail for daily Vault opening and closing events.';
