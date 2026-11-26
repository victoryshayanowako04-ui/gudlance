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
  assert.doesNotMatch(vault, /String\\(exp\\.id\\)\\.includes\\(['"]EXP-INV['"]\\)/);
  assert.doesNotMatch(vault, /sale\\.reconciled === true\\) return/);
  assert.match(vault, /sale\\.usdpaid \\?\\? sale\\.total \\?\\? sale\\.amount/);
  assert.match(vault, /expData\\.method \\|\\| 'Not recorded'/);
});

test('the audited Vault modules load after the existing application script', () => {
  const html = read('index.html');
  const appIndex = html.indexOf('app.js?v=45');
  const coreIndex = html.indexOf('js/vault-financial-core.js?v=1');
  const engineIndex = html.indexOf('js/vault-financial-engine.js?v=1');
  assert.ok(appIndex >= 0 && coreIndex > appIndex && engineIndex > coreIndex);
});

test('daily cash sessions are isolated from the existing financial tables', () => {
  const migration = read('supabase/migrations/20261126100000_vault_daily_cash_sessions.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vault_daily_sessions/);
  assert.match(migration, /UNIQUE \(business_date, currency, drawer_id\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vault_session_audit/);
  assert.match(migration, /status = 'CLOSED'/);
  assert.match(migration, /variance = round\(p_actual_closing - p_expected_closing, 2\)/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.vault_daily_sessions FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.vault_session_audit FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_vault_session/);
});

test('daily Vault endpoint verifies a Chief Admin and never exposes service credentials', () => {
  const endpoint = read('functions/api/vault-session.js');
  assert.match(endpoint, /verifyChiefAdmin/);
  assert.match(endpoint, /export async function onRequestPost/);
  assert.match(endpoint, /context\.env/);
  assert.match(endpoint, /role\.includes\('level 3'\)/);
  assert.match(endpoint, /crypto\.timingSafeEqual/);
  assert.match(endpoint, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(endpoint, /record_vault_session/);
  assert.doesNotMatch(read('js/vault-financial-engine.js'), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(read('js/vault-financial-engine.js'), /localStorage\.setItem/);
});

test('service worker caches the new Vault modules under a new cache version', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /haven-school-v5/);
  assert.match(worker, /vault-financial-core\.js/);
  assert.match(worker, /vault-financial-engine\.js/);
});
