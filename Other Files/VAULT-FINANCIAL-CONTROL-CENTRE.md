# Gudlance Vault Financial Control Centre

## Purpose

This change adds an audited financial calculation layer and a daily physical-cash session without rewriting existing student, POS, payment, expense or payroll records.

The feature is intentionally additive. The existing Finance & Ledger screen remains in place; the new Vault Control Centre is inserted above its existing summary.

## Financial sources and de-duplication

| Source | Use |
| --- | --- |
| student_ledger | Authoritative student receipts, event receipts, shop allocations, overpayments and credit-funded payments |
| transactions | Walk-in POS receipts only; student POS sales are not counted again because their payment is represented in the student ledger |
| expenses | Active paid expenses, including inventory/stock purchases stored in JSON data |
| payroll_history | Only payroll with a confirmed paid status; allocated to the saved payment method |
| payments | Not summed independently because its receipt rows can represent the same payment already present in the student ledger |
| event_history | Not summed independently because event collections are represented in student ledger entries |

Reconciled POS rows remain part of historical reports. Reconciliation is a status, not a reason to erase a financial movement.

## Calculation rules

- All USD arithmetic is performed in integer cents.
- The selected start and end dates are inclusive.
- Empty date filters mean all available history; they do not silently become today.
- A student receipt is counted once from the student ledger. Walk-in POS is counted only when no matching ledger receipt exists.
- A mixed receipt is allocated proportionally across its breakdown lines, with the final line receiving any rounding remainder.
- Overpayment allocations are counted as actual collections and as student credit liability.
- Credit-funded payments reduce student credit liability but do not create a new cash collection.
- Stock purchases reduce the payment channel recorded on the expense, including purchases stored only in JSON.
- Payroll reduces the account indicated by payment_method, not automatically physical cash.
- Missing/unknown methods are reported as unclassified and are never assumed to be cash.
- ZiG is kept separate from USD and is not added to USD cash.

## Daily cash session

The opening float is entered manually for each business date. It is not carried forward automatically.

A session is unique by business date, currency and drawer. The opening amount is recorded once. The standard workflow cannot silently overwrite an opening float or reopen a closed day.

Expected closing cash:

    opening float + cash inflows - cash outflows

Closing stores the expected amount, actual physical count, variance, calculation summary and an append-only audit event. A non-zero variance is recorded, not automatically corrected.

## Security boundary

The daily session tables have RLS enabled and forced, no anon or authenticated table grants, and narrowly scoped service-role access. The audit table is append-only for the service role. The browser never receives a Supabase secret key.

The Supabase Edge Function rechecks the user's Chief Admin role and Vault password server-side before reading or writing a daily session. It uses Supabase's server-side secret environment variables by default, so no service-role key is added to Cloudflare Pages or browser code.

The function reads SUPABASE_URL and prefers SUPABASE_SECRET_KEYS.default, with SUPABASE_SERVICE_ROLE_KEY as a legacy fallback. The endpoint uses the existing custom users table and current Vault password convention. It does not create Supabase Auth users or change the login system.

## Deployment sequence

1. Run CI and review the pull request.
2. The additive daily-session migration and privilege-hardening migration have been applied to the Gudlance Supabase project.
3. The Supabase Edge Function vault-session is deployed with verify_jwt disabled because it performs its own Chief Admin password check.
4. Deploy the updated static app after the PR is merged.
5. Test with a non-production date/session first, then verify the actual cash drawer against the recorded opening float and movement list.

The additive migrations are applied to the live Supabase project. They created only the new Vault session tables, audit table and RPC, and tightened grants on those new objects. Existing financial data was not backfilled, rewritten or deleted.

## Known limitations and review rules

- A movement with no reliable date or payment method is flagged; it is not guessed into a cash or bank total.
- The current daily close workflow records physical USD cash. The existing Vault still shows ZiG expenses and a converted collection figure separately; a complete ZiG opening/closing drawer workflow needs its own confirmed source and operational rules.
- Online channel totals are period movements, not bank-statement closing balances. To reconcile a bank or mobile-money account to its real-world balance, a separate opening and actual closing balance must be recorded for that account.
- Historical student-credit liability is reconstructed from overpayment allocations and credit-backed ledger payments. Unmapped credit rows or negative reconstructed balances must be reviewed before calling the liability fully reconciled.
- The UI marks a calculation with exceptions as requiring review, even when it can still display the classified subtotals.
- No legacy data is silently edited to repair historical gaps.

## Regression coverage

The Node test suite covers money rounding, mixed overpayment allocations, credit-funded payments, stock expenses, reconciled POS rows, duplicate receipt protection, inclusive dates, unclassified payment methods and payroll account allocation. Integration tests cover the script load order, migration access restrictions and server-side Chief Admin checks.


## Existing source-table access
The current Supabase project audit found RLS disabled on 41 existing public-schema tables, including core financial source tables. This change does not alter those policies because a blanket RLS change could break the existing custom-login application. A separate staged access-control rollout is required before claiming that existing financial records are protected from direct client/API access.
