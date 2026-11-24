-- Atomic uniform shop sale persistence.
-- This migration adds no business/test rows. It only creates a sequence and RPC.
CREATE SEQUENCE IF NOT EXISTS public.payments_id_seq;

SELECT setval(
  'public.payments_id_seq',
  GREATEST(COALESCE((SELECT MAX(id) FROM public.payments), 0) + 1, 1),
  false
);

ALTER TABLE public.payments
  ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq');

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;
GRANT USAGE, SELECT ON SEQUENCE public.payments_id_seq TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.process_shop_sale(
  p_sale jsonb,
  p_ledger jsonb,
  p_payment jsonb,
  p_stock jsonb,
  p_credit_applied numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_receipt text;
  v_sale_id text;
  v_student_id text;
  v_item record;
  v_available_credit numeric := 0;
  v_new_balance numeric := 0;
  v_ledger jsonb;
  v_payment_row jsonb;
  v_existing_receipt boolean;
BEGIN
  IF p_sale IS NULL OR jsonb_typeof(p_sale) <> 'object'
     OR p_stock IS NULL OR jsonb_typeof(p_stock) <> 'array'
     OR p_ledger IS NULL OR jsonb_typeof(p_ledger) <> 'array' THEN
    RAISE EXCEPTION 'Invalid shop sale payload';
  END IF;

  v_receipt := NULLIF(btrim(p_sale->>'receipt_no'), '');
  v_sale_id := NULLIF(btrim(p_sale->>'id'), '');
  v_student_id := NULLIF(btrim(p_sale->>'student_id'), '');

  IF v_receipt IS NULL OR v_sale_id IS NULL OR v_student_id IS NULL THEN
    RAISE EXCEPTION 'Sale reference, sale ID and student ID are required';
  END IF;
  IF jsonb_array_length(p_stock) = 0 THEN
    RAISE EXCEPTION 'A sale must contain at least one stock item';
  END IF;
  IF COALESCE((p_sale->>'amount')::numeric, 0) < 0
     OR COALESCE((p_sale->>'total')::numeric, 0) < 0
     OR COALESCE(p_credit_applied, 0) < 0 THEN
    RAISE EXCEPTION 'Sale amounts cannot be negative';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_receipt, 0));

  IF EXISTS (SELECT 1 FROM public.transactions WHERE id = v_sale_id) THEN
    SELECT receipt_no INTO v_receipt FROM public.transactions WHERE id = v_sale_id;
    RETURN jsonb_build_object('receipt_no', v_receipt, 'replayed', true);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.transactions WHERE receipt_no = v_receipt
    UNION ALL
    SELECT 1 FROM public.payments WHERE receipt_no = v_receipt
    UNION ALL
    SELECT 1 FROM public.student_ledger WHERE receipt_no = v_receipt
  ) INTO v_existing_receipt;

  IF v_existing_receipt THEN
    RAISE EXCEPTION 'Receipt reference already exists. Refresh and retry with a new sale reference.';
  END IF;

  IF v_student_id <> 'WALK-IN' THEN
    PERFORM 1 FROM public.students WHERE id = v_student_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Student does not exist';
    END IF;

    SELECT COALESCE(SUM(
      CASE
        WHEN lower(type) IN ('charge', 'fee') THEN amount
        WHEN lower(type) IN ('payment', 'discount', 'waiver', 'credit', 'overpayment') THEN -amount
        ELSE 0
      END
    ), 0)
    INTO v_new_balance
    FROM public.student_ledger
    WHERE student_id = v_student_id
      AND upper(COALESCE(status, 'ACTIVE')) NOT IN ('VOID', 'VOIDED', 'REVERSAL');

    v_available_credit := GREATEST(0, -v_new_balance);
    IF COALESCE(p_credit_applied, 0) > v_available_credit + 0.005 THEN
      RAISE EXCEPTION 'Student credit changed during checkout. Refresh the student account and retry.';
    END IF;
  ELSIF COALESCE(p_credit_applied, 0) > 0 THEN
    RAISE EXCEPTION 'Walk-in sales cannot use student credit';
  END IF;

  FOR v_item IN
    SELECT item_id, quantity
    FROM jsonb_to_recordset(p_stock) AS x(item_id text, quantity bigint)
    ORDER BY item_id
  LOOP
    IF v_item.item_id IS NULL OR v_item.quantity IS NULL OR v_item.quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock quantity in sale';
    END IF;

    PERFORM 1
    FROM public.inventory
    WHERE id = v_item.item_id
      AND COALESCE(qty, 0) >= v_item.quantity
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stock changed or is insufficient for inventory item %', v_item.item_id;
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT item_id, quantity
    FROM jsonb_to_recordset(p_stock) AS x(item_id text, quantity bigint)
    ORDER BY item_id
  LOOP
    UPDATE public.inventory
    SET qty = COALESCE(qty, 0) - v_item.quantity
    WHERE id = v_item.item_id;
  END LOOP;

  INSERT INTO public.transactions
  SELECT (jsonb_populate_record(NULL::public.transactions, p_sale)).*;

  IF v_student_id <> 'WALK-IN' THEN
    FOR v_ledger IN SELECT value FROM jsonb_array_elements(p_ledger)
    LOOP
      IF COALESCE(v_ledger->>'student_id', v_student_id) <> v_student_id THEN
        RAISE EXCEPTION 'Ledger student does not match sale student';
      END IF;

      IF lower(COALESCE(v_ledger->>'type', '')) = 'payment'
         AND COALESCE(p_credit_applied, 0) > 0 THEN
        v_ledger := jsonb_set(
          v_ledger,
          '{amount}',
          to_jsonb(COALESCE((v_ledger->>'amount')::numeric, 0) + p_credit_applied),
          true
        );
      END IF;

      INSERT INTO public.student_ledger
      SELECT (jsonb_populate_record(NULL::public.student_ledger, v_ledger)).*;
    END LOOP;

    SELECT COALESCE(SUM(
      CASE
        WHEN lower(type) IN ('charge', 'fee') THEN amount
        WHEN lower(type) IN ('payment', 'discount', 'waiver', 'credit', 'overpayment') THEN -amount
        ELSE 0
      END
    ), 0)
    INTO v_new_balance
    FROM public.student_ledger
    WHERE student_id = v_student_id
      AND upper(COALESCE(status, 'ACTIVE')) NOT IN ('VOID', 'VOIDED', 'REVERSAL');

    UPDATE public.students
    SET balance_owing = round(v_new_balance, 2)
    WHERE id = v_student_id;
  END IF;

  IF p_payment IS NOT NULL AND jsonb_typeof(p_payment) = 'object' THEN
    v_payment_row := p_payment;
    IF v_student_id = 'WALK-IN' THEN
      v_payment_row := jsonb_set(v_payment_row, '{student_id}', 'null'::jsonb, true);
    ELSE
      v_payment_row := jsonb_set(v_payment_row, '{student_id}', to_jsonb(v_student_id), true);
    END IF;

    INSERT INTO public.payments (
      student_id, date, amount, zig, method, receipt_no, notes,
      category, status, processed_by
    )
    VALUES (
      NULLIF(v_payment_row->>'student_id', 'null'),
      COALESCE((v_payment_row->>'date')::date, CURRENT_DATE),
      COALESCE((v_payment_row->>'amount')::numeric, 0),
      COALESCE((v_payment_row->>'zig')::numeric, 0),
      v_payment_row->>'method',
      v_receipt,
      v_payment_row->>'notes',
      COALESCE(v_payment_row->>'category', 'Shop'),
      COALESCE(v_payment_row->>'status', 'PAID'),
      v_payment_row->>'processed_by'
    );
  END IF;

  RETURN jsonb_build_object(
    'receipt_no', v_receipt,
    'replayed', false,
    'balance_owing', CASE WHEN v_student_id = 'WALK-IN' THEN NULL ELSE round(v_new_balance, 2) END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.process_shop_sale(jsonb, jsonb, jsonb, jsonb, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_shop_sale(jsonb, jsonb, jsonb, jsonb, numeric) TO anon, authenticated;
