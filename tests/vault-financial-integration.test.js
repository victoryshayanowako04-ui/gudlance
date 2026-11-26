const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('legacy Vault no longer defaults an empty start date to today', () => {
  const app = read('app.js');
  assert.doesNotMatch(app, /if \(startDateInput && !startDateInput\.value\)/);
});

test('the Vault calculator includes stock purchases and keeps reconciled POS history', () => {
  const app = read('app.js');
  const start = app.indexOf("window.calculateVaultStats = async function()");
  const end = app.indexOf("// Reconciliation Functions", start);
  assert.notEqual(start, -1, 'Vault calculator must exist');
  assert.notEqual(end, -1, 'Vault calculator boundary must exist');
  const vault = app.slice(start, end);
  assert.doesNotMatch(vault, /String\(exp\.id\)\.includes\(['"]EXP-INV['"]\)/);
  assert.doesNotMatch(vault, /sale\.reconciled === true\) return/);
  assert.match(vault, /sale\.usdpaid \?\? sale\.total \?\? sale\.amount/);
  assert.match(vault, /expData\.method \|\| 'Not recorded'/);
  const unlock = app.slice(app.indexOf('window.unlockAdminFinance'), app.indexOf('window.lockAdminFinance'));
  assert.match(unlock, /window\.openSecureVault\(\)/);
  assert.doesNotMatch(unlock, /password_hash|from\(['\"]users['\"]\)/);
});

test('the audited Vault modules load after the existing application script', () => {
  const html = read('index.html');
  const appIndex = html.indexOf('app.js?v=46');
  const coreIndex = html.indexOf('js/vault-financial-core.js?v=4');
  const engineIndex = html.indexOf('js/vault-financial-engine.js?v=14');
  const authIndex = html.indexOf('js/vault-auth.js?v=1');
  assert.ok(appIndex >= 0 && coreIndex > appIndex && engineIndex > coreIndex && authIndex > engineIndex);
});


test('Vault unlock is single-flight and verifies credentials through the server', () => {
  const auth = read('js/vault-auth.js');
  const app = read('app.js');
  const unlock = app.slice(app.indexOf('window.unlockAdminFinance'), app.indexOf('window.lockAdminFinance'));
  assert.match(auth, /let unlockPromise = null/);
  assert.match(auth, /if \(unlockPromise\) return unlockPromise/);
  assert.match(auth, /window\.verifyVaultSession\(today\)/);
  assert.match(auth, /window\.setVaultSessionPassword\(password\)/);
  assert.doesNotMatch(auth, /supabaseClient\.from\(['"]users['"]\)/);
  assert.doesNotMatch(unlock, /password_hash/);
});

test('daily cash sessions are isolated from the existing financial tables', () => {
  const migration = read('supabase/migrations/20261126100000_vault_daily_cash_sessions.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vault_daily_sessions/);
  assert.match(migration, /UNIQUE \(business_date, currency, drawer_id\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vault_session_audit/);
  assert.match(migration, /status = 'CLOSED'/);
  assert.match(migration, /variance = round\(p_actual_closing - p_expected_closing, 2\)/);
  assert.match(migration, /is_verified =/);
  assert.match(migration, /exception_count =/);
  assert.match(migration, /movement_count =/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.vault_daily_sessions FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.vault_session_audit FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /SECURITY INVOKER/);
  assert.doesNotMatch(migration, /SECURITY DEFINER/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_vault_session/);
});

test('Vault calculations run through the authenticated server function, not browser table reads', () => {
  const endpoint = read('supabase/functions/vault-session/index.ts');
  const engine = read('js/vault-financial-engine.js');
  assert.match(endpoint, /verifyChiefAdmin/);
  assert.match(endpoint, /Deno\.serve/);
  assert.match(endpoint, /Deno\.env\.get\('SUPABASE_URL'\)/);
  assert.match(endpoint, /role\.includes\('level 3'\)/);
  assert.match(endpoint, /safeEqual/);
  assert.match(endpoint, /SUPABASE_SECRET_KEYS/);
  assert.match(endpoint, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(endpoint, /action === 'calculate'/);
  assert.match(endpoint, /fetchAllVaultRows/);
  assert.match(endpoint, /globalThis\.GudlanceVaultCore/);
  assert.match(endpoint, /record_vault_session/);
  assert.match(endpoint, /isAllowedOrigin/);
  assert.match(endpoint, /gudlance\.pages\.dev/);
  assert.match(endpoint, /rawBody.length > 120000/);
  assert.match(endpoint, /Unsupported Vault currency/);
  assert.match(engine, /sessionRequest\('calculate'/);
  assert.match(engine, /zigTenderCents/);
  assert.match(engine, /vcpZigNote/);
  assert.match(engine, /sessionExceptionsFor/);
  assert.doesNotMatch(engine, /conversionRate/);
  assert.doesNotMatch(engine, /supabaseClient\.from\(/);
  assert.doesNotMatch(engine, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(engine, /localStorage\.setItem/);
  assert.match(read('supabase/config.toml'), /verify_jwt = false/);
  assert.equal(read('js/vault-financial-core.js'), read('supabase/functions/vault-session/vault-financial-core.js'));
});

test('the follow-up session migration adds verification state without rewriting finance records', () => {
  const migration = read('supabase/migrations/20261126200000_vault_session_verification_state.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS is_verified/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS exception_count/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS movement_count/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.record_vault_session/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM/i);
});

test('service worker caches the new Vault modules under a new cache version', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /haven-school-v18/);
  assert.match(worker, /vault-financial-core\.js/);
  assert.match(worker, /vault-financial-engine\.js/);
  assert.match(worker, /vault-auth\.js/);
});


test('the existing billed, debt, discount and waiver summary still refreshes', () => {
  const engine = read('js/vault-financial-engine.js');
  assert.match(engine, /await originalCalculate\.apply\(this, arguments\)/);
  assert.match(engine, /const result = await refreshFinancialVault\(\{ silent: true \}\)/);
});

test('class and student filter typing is debounced and clearly scoped', () => {
  const engine = read('js/vault-financial-engine.js');
  const html = read('index.html');
  assert.match(engine, /function scheduleVaultStatsRefresh\(\)/);
  assert.match(engine, /setTimeout\(\(\) => \{/);
  assert.match(html, /oninput="scheduleVaultStatsRefresh\(\)"/);
  assert.doesNotMatch(html, /onkeyup="calculateVaultStats\(\)"/);
  assert.match(engine, /Class and student filters continue to apply to the existing student summary below/);
});

test('closed sessions warn when new or changed activity appears after closing', () => {
  const engine = read('js/vault-financial-engine.js');
  assert.match(engine, /const closingSnapshot = session\.closing_snapshot/);
  assert.match(engine, /const activityChanged = closed/);
  assert.match(engine, /Closed · activity changed/);
  assert.match(engine, /New or changed financial activity was detected after closing/);
});

test('the browser submits only the physical count when closing a day', () => {
  const engine = read('js/vault-financial-engine.js');
  assert.match(engine, /sessionRequest\('close', \{ actualClosing: actual \}\)/);
  assert.doesNotMatch(engine, /expectedClosing:\s*expected/);
  assert.doesNotMatch(engine, /snapshot:\s*\{/);
});


test('system discount allocations have a separate non-cash Vault total', () => {
  const engine = read('js/vault-financial-engine.js');
  assert.match(engine, /vcpNonCashAdjustments/);
  assert.match(engine, /totals\.nonCashAdjustmentsCents/);
});


test('Vault authentication throttle is private and service-role only', () => {
  const migration = read('supabase/migrations/20261126210000_vault_auth_rate_limit.sql');
  const edge = read('supabase/functions/vault-session/index.ts');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vault_auth_throttle/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.vault_auth_throttle FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.consume_vault_auth_attempt/);
  assert.match(edge, /consumeVaultAuthThrottle\(userId, request\)/);
  assert.match(edge, /clearVaultAuthThrottle\(throttle\.keys\)/);
});
