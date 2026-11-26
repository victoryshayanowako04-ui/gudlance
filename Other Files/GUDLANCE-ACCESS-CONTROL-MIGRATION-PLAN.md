# Gudlance Access-Control Migration Plan

Status: read-only assessment and staged plan. No existing application access policies or source-table grants have been changed.

## Why this is a release blocker

The current production database has RLS disabled and broad `anon` / `authenticated` grants on sensitive public tables, including:

- `users`
- `payments`
- `student_ledger`
- `expenses`
- `transactions`
- `payroll_history`

The browser uses the Supabase publishable key, so these grants allow direct REST access outside the application's visible login screen. The Vault Chief Admin password check does not protect those existing REST endpoints.

The current application also uses a custom client-side login rather than Supabase Auth:
- `app.js` directly queries `users` and selects `password_hash` and `data`.
- Password comparison happens in browser code.
- The current user context is persisted in `localStorage`.
- Role and permission checks are performed in client-side JavaScript.
- A hard-coded developer/God Mode bypass exists in the client bundle. Treat its credential as compromised; do not reproduce it in documentation or commit messages.

A read-only source scan found 243 direct `.from()` call sites in `app.js`, spanning 30 tables, plus a direct attendance query in `parent-portal.js`. This is why blanket-enabling RLS would break the currently working system.

## Security goals

1. No anonymous client can read or modify student, payment, expense, payroll or user records.
2. User identity and role must be verified server-side and represented by a signed, short-lived session.
3. Database policies must enforce access even if someone edits browser JavaScript or localStorage.
4. Every existing module must continue working with the same records and business rules.
5. No passwords, service-role keys or break-glass credentials are embedded in browser assets or Git history.

## Recommended architecture

Prefer Supabase Auth for identity, with the existing application roles mapped to signed JWT claims or a protected role/profile table.

If a staged custom-auth bridge is required, it must be implemented entirely server-side:
- Verify credentials against a secure password hash.
- Issue a signed, expiring session token.
- Never trust a user ID or role supplied only by the browser.
- Validate the token and role for every protected Edge Function operation.
- Keep service-role credentials only in server-side secrets.

The existing custom user records must be migrated through a controlled password-reset or re-enrolment flow. Do not copy any plaintext password into Supabase Auth or a new table.

## Phased rollout

### Phase 0: Containment and inventory

- Remove the client-side developer/God Mode bypass from production builds.
- Rotate the credential associated with that bypass and any other credential that has appeared in source control.
- Search the full repository and deployment environment for hard-coded passwords, API secrets and service-role keys.
- Confirm which tables and operations are required by each role.
- Preserve the current application until the replacement authentication path is tested.

### Phase 1: Identity and session

- Introduce Supabase Auth or a signed server-side session.
- Migrate user identities without copying plaintext credentials.
- Replace the current browser-side password comparison.
- Replace localStorage role authority with verified server-side identity and claims.
- Keep the existing role names and permissions until they are mapped and approved.

### Phase 2: Table and operation matrix

Create a table-by-table access matrix for all 30 tables and the additional portal query.

For each table, document:
- Roles allowed to select, insert, update and delete.
- Row ownership rules (school, class, student, staff member or finance scope).
- Whether the operation must go through an Edge Function.
- Whether audit logging is mandatory.
- Whether anonymous access must be denied completely.

Do not infer policies from the UI alone. Confirm every query and mutation in the source code.

### Phase 3: Staging policies

- Create a staging Supabase project or isolated database branch.
- Add policies before enabling RLS on each table group.
- Test reads, writes, exports, reports, background sync and offline retry for every role.
- Verify direct REST calls with an anon key are denied.
- Verify an authenticated user cannot access another role's or school's records.
- Keep a rollback migration for every policy group.

### Phase 4: Gradual cutover

Recommended order:
1. User and role records.
2. Student records and student ledger.
3. Payments and receipts.
4. Expenses, payroll and accounting.
5. POS, inventory and suppliers.
6. Attendance, parent portal and other modules.
7. Audit, reports and settings.

Enable RLS and remove broad anon grants only after the corresponding module passes staging tests. Do not enable RLS across all 30 tables in one migration.

### Phase 5: Production verification

- Confirm anonymous REST requests cannot read or write sensitive tables.
- Confirm each role can perform only its approved operations.
- Confirm login, logout, session expiry and concurrent sessions.
- Confirm offline sync cannot bypass server authorization.
- Confirm no hard-coded credentials or service-role keys exist in deployed browser assets.
- Monitor denied requests and application errors after each rollout group.

## Vault-specific status

The new Vault tables are already isolated:
- `vault_daily_sessions`
- `vault_session_audit`
- `vault_auth_throttle`

They have RLS enabled and forced, no anon/authenticated table grants, and service-role-only server RPC access. The `vault-session` Edge Function performs Chief Admin verification and persistent rate limiting.

This protects the new Vault session records. It does not fix the existing source-table exposure.

## Release gate

Do not merge the Vault UI to `main` on the assumption that the whole application is secure. First review the preview, then approve a separate staged access-control migration. Existing modules must remain functional throughout the rollout.
