# Gudlance Security Implementation Plan

Status: **active implementation plan, based on a read-only production audit on 26 November 2026**.

This document records the security work required before the Vault feature and the wider application can be described as production-secure. It does not authorize blanket RLS changes or changes to existing financial records.

## 1. Production audit findings

### Database exposure

The active Supabase project is **Gudlance** (project ref: fjhtyaqnjqpyhnwqbjem, PostgreSQL 17.11).

Read-only catalog checks found:

| Finding | Current result |
|---|---:|
| Public tables | 48 |
| RLS disabled | 41 |
| RLS enabled but not forced | 4 |
| RLS enabled and forced | 3 |
| Tables with grants to anon | 45 |
| Tables with grants to authenticated | 45 |

The three forced-RLS tables are the Vault session, Vault audit and Vault authentication-throttle tables. Their direct anon and authenticated grants are absent.

The existing application tables remain broadly exposed. Sensitive tables include users, payments, student_ledger, expenses, transactions and payroll_history.

Additional policy findings:

- attendance has a PUBLIC policy allowing all operations with an unconditional predicate.
- school_data has two PUBLIC all-operation policies with unconditional predicates.
- payment_reference_claims has unconditional select, insert and delete policies for anon and authenticated.
- payments, student_ledger, students and transactions have broad authenticated delete policies.
- These policies must be reviewed and replaced before RLS is enabled on their tables. Enabling RLS without replacing permissive policies would not secure those tables.
- The event_payments_view view has security_invoker=true.
- The catalog scan found no public SECURITY DEFINER function executable by anon or authenticated; the only public SECURITY DEFINER function returned by the scan was not executable by either role.

### Application access paths

A source scan of the current main-branch app.js found **259 direct Supabase .from() call sites across 33 distinct relation/resource names**. This count includes a view and a Storage resource, not just base tables. The parent portal also has a direct attendance query.

The application currently:

- Reads users.password_hash and the data JSON from the browser during login.
- Compares the entered password with values returned to browser JavaScript.
- Persists the current user identity and role in localStorage.
- Performs role and permission checks in client-side JavaScript.
- Creates users with legacy pass and password values in the user data object.
- Uses direct browser-side Supabase queries throughout the working modules.

The current source also contains a hard-coded developer login bypass and a hard-coded developer override in the client-side factory-reset flow. These values are treated as compromised and are deliberately not reproduced here. The factory-reset path performs direct client-side deletes across multiple tables and must not remain protected only by browser-side prompts or role checks.

### Existing user records

A read-only aggregate check found:

| Item | Count |
|---|---:|
| Rows in users | 19 |
| Non-empty password_hash values | 7 |
| Rows with legacy data.pass values | 19 |
| Rows with legacy data.password values | 19 |
| Rows with an email address | 1 |
| Rows in app_users | 0 |
| Supabase Auth users | 0 |
| Level 1 / Level 2 / Level 3 roles | 13 / 2 / 4 |

All 7 non-empty password_hash values exactly match the corresponding legacy data.pass and data.password values. None matched the checked bcrypt, Argon2 or SHA-256 hex formats. The password_hash column name is misleading: these are legacy plaintext credentials, not secure password hashes.

The users table is the active legacy account source. The empty app_users table is not currently the login source. The account migration must preserve the existing username-based login experience; it must not assume that every staff member has an email address.

### Vault backend

The vault-session Edge Function is active at **version 6**. Its own session, audit and throttle tables are forced-RLS and have no direct anon or authenticated table grants.

The function currently verifies the supplied user ID and password server-side and rate-limits attempts. It still relies on the legacy user credential fields and does not yet issue a normal Supabase Auth session for the wider application. The Vault's isolated tables are protected, but the existing source tables it reads are not thereby protected.

## 2. Non-negotiable safety rules

1. Do not enable RLS on all public tables in one operation.
2. Do not revoke the current browser access grants before the replacement authenticated path is deployed and tested.
3. Do not trust localStorage, a browser-supplied user ID, a browser-supplied role or a hidden UI control as authorization.
4. Do not expose password fields, service-role keys, secret API keys or developer override credentials in browser assets.
5. Do not rewrite, backfill, delete or fabricate financial records as part of the security migration.
6. Preserve the existing roles, permissions, business rules, data, offline behavior and working modules during each migration group.
7. Every policy group needs a tested rollback migration and a role-by-role regression suite.
8. Do not use production financial records as test fixtures and do not create fake opening floats, closing sessions or transactions in the live Vault.

## 3. Target architecture

Use Supabase Auth as the source of signed user sessions, with the current username/password form retained as the user-facing login experience.

A server-side username authentication bridge will:

1. Receive a username and password over HTTPS.
2. Rate-limit attempts and verify the legacy account without returning credential fields to the browser.
3. Map the legacy account to a Supabase Auth identity using a protected server-side mapping.
4. Migrate the account to a secure Auth credential/session flow without requiring an email address that the user does not have.
5. Return a valid Supabase Auth session to the browser.
6. Put the approved application role in protected app metadata or a server-controlled role table. Never use user-editable metadata for authorization.

After the cutover, the existing Supabase client should use the authenticated session so existing query code can be migrated in controlled groups rather than replaced all at once.

Legacy password values must be removed from public user JSON as each account is securely migrated. The browser must never receive password hashes or legacy password fields.

## 4. Phased implementation

### Phase 0: Immediate containment

- Remove the hard-coded developer login bypass.
- Remove the hard-coded developer override from the factory-reset code.
- Replace client-side factory reset with a disabled, clearly explained action until a server-side, role-verified, audited and explicitly confirmed reset workflow exists.
- Search the repository and deployment configuration for other hard-coded credentials and secrets. Rotate any credential that has been reused outside the removed code.
- Keep ordinary username/password login unchanged until the server-side replacement is ready.

### Phase 1: Authentication bridge

- Build a server-side username login endpoint with persistent rate limiting.
- Establish a protected mapping between the 19 legacy user records and Supabase Auth identities.
- Preserve existing role names and map them to server-controlled claims.
- Keep the login form and username workflow; do not require staff to invent email addresses.
- Add session expiry, refresh, logout, session revocation and concurrent-session handling.
- Migrate legacy password fields out of the public users.data JSON. Do not copy plaintext passwords into a new public table.

### Phase 2: Full access inventory

Create a table-and-operation matrix for every exposed table, view, RPC and Storage resource.

For each resource, document:

- Allowed roles for select, insert, update and delete.
- Row scope and ownership rules.
- Whether the operation must use an Edge Function.
- Required audit logging.
- Whether parent/guardian access is required.
- Whether anonymous access is required for a narrowly defined public workflow.

Do not infer database permissions from which buttons happen to be visible in the interface.

### Phase 3: Staging policy groups

Use an isolated staging database or local Supabase environment. Do not test new policies directly against the live financial tables first.

For every group:

- Create restrictive policies before enabling RLS.
- Remove broad grants and permissive policies only for that tested group.
- Test direct REST requests with the publishable key and no session.
- Test each application role's allowed and denied operations.
- Test parent/guardian isolation.
- Test exports, reports, uploads, offline queue retries and synchronization.
- Keep a rollback migration and verify it before proceeding.

### Phase 4: Gradual cutover

Recommended sequence:

1. User directory, roles and authentication.
2. Students, classes, teachers and parent/student links.
3. Student ledger, payments, payment breakdowns, receipts and transactions.
4. Expenses, payroll, accounting and reconciliation.
5. POS, inventory, shop sales and suppliers.
6. Attendance, parent portal and academic records.
7. Settings, audit logs, reports, announcements and remaining modules.

The exact table grouping must be confirmed by the completed access matrix. No group is enabled in production until its tests pass.

### Phase 5: Production verification and Vault release

- Anonymous direct REST reads and writes to sensitive tables are denied.
- Each role can perform only its approved operations.
- Parent accounts can access only their linked students.
- Login, logout, session expiry and concurrent sessions work.
- Offline sync cannot bypass server authorization.
- No credentials or service-role keys are present in browser assets.
- All regression tests pass and the Pages deployment is verified.
- Only then should the Vault UI PR be released to main.

## 5. Current release status

- Vault PR #1 remains open and draft; it has not been merged.
- Phase 0 containment is committed directly to main in **25f397f1edb10178f57cb74d84eb48754d83972a**.
- That commit removes the hard-coded developer login bypass and developer factory-reset override, removes special God Mode privileges, disables the unsafe client-side Factory Reset, restricts maintenance controls to the Level 3 role, bumps the app and service-worker cache versions, and adds five security regression tests.
- The normal username/password login path remains present. It still performs legacy credential comparison in browser code and stores role state client-side, so this is containment, not the completed authentication migration.
- The Vault PR feature branch has not yet been synced with the main-branch containment commit. Its preview still uses the pre-containment app.js and must not be used for interactive testing. Merging that branch as-is would reintroduce the developer bypass and client-side factory-reset code.
- The Vault preview uses the live Supabase project. Any real opening float or closing count entered there creates a real financial record.
- The Vault backend is version 6.
- The isolated Vault suite contains 48 tests. The main-branch security regression tests passed locally: **5 passed, 0 failed**.
- GitHub Actions run 125 for the Vault PR was retried but again failed before any step started. The job returned no steps, so this is a runner-allocation failure, not a test assertion result. A successful hosted CI run is still outstanding.
- No existing financial source records were modified during this audit or the Phase 0 commit.
- No existing application table grants or RLS policies were changed.

**Next implementation target:** build and test the username-based Supabase Auth bridge while keeping the existing application login available. Do not enable RLS or revoke current application grants until the bridge and the first table group are verified.
