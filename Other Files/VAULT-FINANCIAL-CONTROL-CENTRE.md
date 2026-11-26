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
| payments | Fallback only when a paid receipt/student pair is missing from the ledger; skipped when the same walk-in receipt is already represented in POS |
| event_history | Not summed independently because event collections are represented in student ledger entries |

Reconciled POS rows remain part of historical reports. Reconciliation is a status, not a reason to erase a financial movement.

## Calculation rules

- All USD arithmetic is performed in integer cents.
- The selected start and end dates are inclusive.
- Empty date filters mean all available history; they do not silently become today.
- A student receipt is counted once from the student ledger. A paid `payments` row is used as a flagged fallback only when its receipt/student pair is missing from the ledger. Walk-in POS is counted once; matching payment-table rows are not added again.
- A mixed receipt is allocated proportionally across its breakdown lines, with the final line receiving any rounding remainder.
- Explicit overpayment allocations are counted as actual collections and as student credit liability. `Covered by Advance Credit` is a credit application, not a new overpayment.
- Credit-funded payments reduce student credit liability but do not create a new cash collection or inflate period overpayments. Mixed credit/cash receipts allocate only the actual cash portion to cash movements.
- Stock purchases reduce the payment channel recorded on the expense, including purchases stored only in JSON.
- System-generated `EXP-DISC-*` / `Discount Allocation` entries are non-cash student discounts. They remain visible in a separate non-cash adjustment total and are not counted as paid expenses or cash outflows.
- Payroll reduces the account indicated by payment_method, not automatically physical cash.
- Missing/unknown methods are reported as unclassified and are never assumed to be cash.
- ZiG is kept separate from USD and is not added to USD cash.
- Server reads are date-scoped for student ledger movements, POS, payments and payroll. The ledger query retains prior payment/overpayment records through the selected end date because outstanding student credit is an as-of-date liability. Expense rows are still read in full because older records store their business date inside JSON data; the engine applies the selected period consistently. Undated source rows remain visible as exceptions rather than being silently filtered out.

## Daily cash session

The opening float is entered manually for each business date. It is not carried forward automatically.

A session is unique by business date, currency and drawer. The opening amount is recorded once. The standard workflow cannot silently overwrite an opening float or reopen a closed day.

Expected closing cash:

    opening float + cash inflows - cash outflows

Closing stores the expected amount, actual physical count, variance, movement references, exception references and an append-only audit event. The browser submits only the physical count. The Edge Function reads the saved opening float, recalculates the selected business date from the financial sources and builds the closing snapshot on the server; browser-supplied expected totals or snapshots are not trusted. A day is marked fully reconciled only when the variance is zero and there are no calculation exceptions. A non-zero variance is recorded, not automatically corrected.

When a closed day is opened again, the current calculation is compared with the saved closing snapshot. If a backdated receipt, expense, reversal or other financial change alters the movement count or totals, the UI marks the close as having changed activity and requires authorised review. The original closing record is not silently rewritten.

## Security boundary

The daily session tables have RLS enabled and forced, no anon or authenticated table grants, and narrowly scoped service-role access. The audit table is append-only for the service role. The browser never receives a Supabase secret key.

The Supabase Edge Function rechecks the user's Chief Admin role and Vault password server-side before reading or writing a daily session. Browser origins are restricted to the Gudlance Pages production domain and its project preview subdomains. It uses Supabase's server-side secret environment variables by default, so no service-role key is added to Cloudflare Pages or browser code.

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
- Historical student-credit liability is reconstructed from explicit overpayment entries and reduced by advance-credit settlements. Credit-allocation reversals are not treated as new overpayments. Unmapped credit rows or negative reconstructed balances must be reviewed before calling the liability fully reconciled.
- The UI marks a calculation with exceptions as requiring review, even when it can still display the classified subtotals.
- The Control Centre is a school-wide financial view for the selected dates. The existing class and student filters continue to apply to the legacy student summary below it; they do not narrow school-wide expenses or payroll. Filter typing is debounced to avoid recalculating on every keystroke.
- The existing billed, debt, discount and waiver summary is still refreshed by its original calculator before the audited Control Centre overrides cash totals. This preserves the established student-summary behaviour while making the cash figures authoritative.
- No legacy data is silently edited to repair historical gaps.

## Verified historical baseline (24 November 2026)

The read-only source reconciliation establishes:
- Cash collections: $758.00
- EcoCash collections: $223.00
- Cash outflows: $605.00, including $320.00 stock purchases
- EcoCash outflows: $610.00
- Net cash movement: $153.00
- Net EcoCash movement: -$387.00
- Total collections: $981.00
- Total expenses: $1,215.00
- Period overpayments: $135.00
- Reconstructed student-credit liability as at 24 November: $9,032.95 after deducting $179.00 of advance-credit settlements from $9,211.95 of active overpayment entries.

The two walk-in shop receipts also present in the payments table are not added twice. Five other historical paid payment rows have no matching student-ledger record; they are included as fallback movements and explicitly flagged for review.

## Vault authentication protection

The Vault Edge Function uses database-backed rate limiting before checking a Chief Admin password:
- Separate hashed buckets are maintained for the client IP and the user/IP pair.
- The first five failed attempts in a five-minute window can be checked; the next request is blocked.
- A blocked bucket remains blocked for 15 minutes.
- Successful authentication clears both buckets.
- Only SHA-256 hashes are stored. Raw IP addresses and passwords are not written to the throttle table.
- The throttle table is RLS-enabled and forced, with access granted only to the service role through the Edge Function.

## Existing application access-control blocker

The new Vault session, audit and authentication-throttle tables are RLS-enabled and forced, with no anon/authenticated grants. The Vault Edge Function is the only intended path to those session records.

The existing financial source tables are a separate, pre-existing risk. Live grants and table metadata show RLS disabled and broad `anon` / `authenticated` privileges on `payments`, `student_ledger`, `expenses`, `transactions`, `payroll_history` and `users`. The browser uses the Supabase publishable key, so the Vault password check does not protect those direct REST endpoints.

Do not apply a blanket RLS change to these existing tables: the current custom-login application relies on direct browser access, and an abrupt policy change would break working modules. A staged migration to server-side authentication and role-aware database policies is required before claiming the whole application is production-secure. The Vault UI change is therefore held out of `main` until that access-control plan is reviewed and tested.

## All-time source exceptions (26 November 2026)

The full historical calculation identifies 30 unresolved source exceptions:
- 5 paid receipts exist in the payments table without a matching student-ledger record. They are included once as flagged fallback collections.
- 25 active expenses have no reliable payment method. Their amount is kept in Unclassified rather than being assumed to be cash or an online account.
- 38 system-generated discount allocations total $786.50. These are non-cash adjustments, not expense payments, and are shown separately.

The live database has not been rewritten to resolve these exceptions. Each requires review against the original receipt or expense evidence.

## ZiG handling and known limitation

The live source schema stores some student payments as a USD-equivalent amount plus a separate actual ZiG tender amount, but it does not persist the historical exchange rate needed to split the USD and ZiG portions of mixed payments. POS records have separate usdpaid and zigpaid fields, so their USD tender can be counted independently.

The Vault therefore:
- Shows actual recorded ZiG tender and ZiG expenses separately.
- Never converts USD totals into ZiG using today's rate.
- Keeps legacy mixed student receipts in Unclassified for USD cash reconciliation and flags the missing historical rate.
- Keeps ZiG expenses out of USD Net Cash and flags ZiG activity for separate reconciliation.
- Does not yet provide a ZiG opening-float/closing-count session. The daily physical session in this release is USD-only.

The live database currently has zero active ZiG tender rows, zero active POS ZiG tender rows and no ZiG expense currency records. This limitation does not change the verified 24 November USD baseline. Full ZiG drawer reconciliation requires storing the exchange rate at payment time and adding a separate ZiG daily session.

## Regression coverage

The Node test suite covers money rounding, mixed overpayment allocations, advance-credit settlements, mixed cash/credit allocation, missing-ledger receipt fallback, walk-in POS de-duplication, ZiG/USD separation, stock expenses, reconciled POS rows, inclusive dates, unclassified payment methods and payroll account allocation. Integration tests cover the script load order, migration access restrictions, server-side Chief Admin checks, preservation of the legacy student summary, debounced filters, post-close activity detection, secret-key preference and server-authoritative closing.


## Existing source-table access
The current Supabase project audit found RLS disabled on 41 existing public-schema tables, including core financial source tables. This change does not alter those policies because a blanket RLS change could break the existing custom-login application. A separate staged access-control rollout is required before claiming that existing financial records are protected from direct client/API access.
