const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../supabase/functions/vault-session/index.ts'),
  'utf8'
).replace(/^import ['\"]\.\/vault-financial-core\.js['\"];\s*/, '');
const vaultCore = require('../js/vault-financial-core');
const allowedOrigin = 'https://feature-vault-financial-reco.gudlance.pages.dev';

function createHandler(options = {}) {
  let handler = null;
  const calls = [];
  const users = options.users || [];
  const sessions = options.sessions || [];
  const sources = options.sources || {};
  const rateLimitAllowed = options.rateLimitAllowed !== false;
  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-server-key',
    ...(options.env || {})
  };
  const mockFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: String(url), method, headers: init.headers || {}, body: init.body || null });
    const parsed = new URL(String(url));
    const table = parsed.pathname.split('/').pop();
    if (table === 'consume_vault_auth_attempt') {
      return new Response(JSON.stringify([{
        allowed: rateLimitAllowed,
        attempts: rateLimitAllowed ? 1 : 6,
        retry_after_seconds: rateLimitAllowed ? 0 : 900
      }]), { status: 200 });
    }
    if (table === 'clear_vault_auth_attempt') return new Response('null', { status: 200 });
    if (table === 'users') return new Response(JSON.stringify(users), { status: 200 });
    if (table === 'vault_daily_sessions') return new Response(JSON.stringify(sessions), { status: 200 });
    if (table === 'record_vault_session') {
      const rpcBody = JSON.parse(init.body || '{}');
      return new Response(JSON.stringify({
        id: 'session-1',
        business_date: rpcBody.p_business_date,
        currency: rpcBody.p_currency,
        drawer_id: rpcBody.p_drawer_id,
        opening_float: 100,
        expected_closing: rpcBody.p_expected_closing,
        actual_closing: rpcBody.p_actual_closing,
        variance: Number(rpcBody.p_actual_closing) - Number(rpcBody.p_expected_closing),
        closing_snapshot: rpcBody.p_snapshot,
        status: 'CLOSED',
        is_verified: Number(rpcBody.p_actual_closing) === Number(rpcBody.p_expected_closing) && Number(rpcBody.p_snapshot?.exceptionCount || 0) === 0
      }), { status: 200 });
    }
    if (Object.prototype.hasOwnProperty.call(sources, table)) {
      return new Response(JSON.stringify(sources[table] || []), { status: 200 });
    }
    throw new Error('Unexpected Vault test request: ' + url);
  };
  vm.runInNewContext(source, {
    Deno: {
      env: { get: name => env[name] || '' },
      serve: callback => { handler = callback; }
    },
    GudlanceVaultCore: vaultCore,
    fetch: mockFetch,
    TextEncoder,
    URL,
    URLSearchParams,
    Response,
    Request,
    Headers,
    crypto,
    console
  }, { filename: 'supabase/functions/vault-session/index.ts' });
  assert.equal(typeof handler, 'function');
  return { handler, calls };
}

function post(body, origin = allowedOrigin, contentType = 'application/json') {
  return new Request('https://example.supabase.co/functions/v1/vault-session', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': contentType },
    body
  });
}

test('Vault CORS allows the Gudlance production and Pages preview domains only', async () => {
  const { handler } = createHandler();
  const allowed = await handler(new Request('https://example.supabase.co/functions/v1/vault-session', {
    method: 'OPTIONS',
    headers: { Origin: allowedOrigin }
  }));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), allowedOrigin);

  const denied = await handler(new Request('https://example.supabase.co/functions/v1/vault-session', {
    method: 'OPTIONS',
    headers: { Origin: 'https://unrelated.example.com' }
  }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});

test('Vault endpoint rejects cross-origin POST requests before database access', async () => {
  const { handler, calls } = createHandler();
  const response = await handler(post(JSON.stringify({
    action: 'read', userId: 'chief-1', password: 'anything', businessDate: '2026-11-24'
  }), 'https://attacker.example.com'));
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test('Vault endpoint rejects non-JSON and malformed JSON requests', async () => {
  const { handler, calls } = createHandler();
  const wrongType = await handler(post('{}', allowedOrigin, 'text/plain'));
  assert.equal(wrongType.status, 415);
  const malformed = await handler(post('{not-json'));
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 0);
});

test('Vault read requires a valid Chief Admin and password and does not write records', async () => {
  const { handler, calls } = createHandler({
    users: [{ id: 'chief-1', role: 'Level 3 - Chief Admin', password_hash: 'correct-pass', data: {} }],
    sessions: []
  });
  const response = await handler(post(JSON.stringify({
    action: 'read', userId: 'chief-1', password: 'correct-pass',
    businessDate: '2026-11-24', currency: 'USD'
  })));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.session, null);
  assert.deepEqual(calls.filter(call => !call.url.includes('/rpc/')).map(call => call.method), ['GET', 'GET']);
  assert.equal(calls.filter(call => call.url.includes('/rpc/consume_vault_auth_attempt')).length, 2);
  assert.equal(calls.filter(call => call.url.includes('/rpc/clear_vault_auth_attempt')).length, 2);
  assert.ok(calls.every(call => call.headers.apikey === 'test-server-key'));
});

test('Vault rejects incorrect passwords and non-Chief-Admin accounts', async () => {
  const { handler: wrongPassword } = createHandler({
    users: [{ id: 'chief-1', role: 'Level 3 - Chief Admin', password_hash: 'correct-pass', data: {} }]
  });
  const wrong = await wrongPassword(post(JSON.stringify({
    action: 'read', userId: 'chief-1', password: 'wrong-pass', businessDate: '2026-11-24'
  })));
  assert.equal(wrong.status, 401);

  const { handler: wrongRole } = createHandler({
    users: [{ id: 'staff-1', role: 'Level 2 - Admin', password_hash: 'correct-pass', data: {} }]
  });
  const denied = await wrongRole(post(JSON.stringify({
    action: 'read', userId: 'staff-1', password: 'correct-pass', businessDate: '2026-11-24'
  })));
  assert.equal(denied.status, 403);
});

test('Vault rejects invalid dates and unsupported currencies before authentication', async () => {
  const { handler, calls } = createHandler();
  const invalidDate = await handler(post(JSON.stringify({
    action: 'read', userId: 'chief-1', password: 'x', businessDate: '2026-02-30'
  })));
  assert.equal(invalidDate.status, 400);
  const invalidCurrency = await handler(post(JSON.stringify({
    action: 'read', userId: 'chief-1', password: 'x', businessDate: '2026-11-24', currency: 'BTC'
  })));
  assert.equal(invalidCurrency.status, 400);
  assert.equal(calls.length, 0);
});


test('Vault financial calculations run server-side after Chief Admin verification', async () => {
  const { handler, calls } = createHandler({
    users: [{ id: 'chief-1', role: 'Level 3 - Chief Admin', password_hash: 'correct-pass', data: {} }],
    sources: {
      student_ledger: [{
        id: 'LEDGER-1', student_id: 'STU-1', date: '2026-11-24', type: 'payment',
        amount: 25, method: 'Cash', status: 'ACTIVE', receipt_no: 'R-1'
      }],
      transactions: [],
      expenses: [],
      payroll_history: [],
      payments: []
    }
  });
  const response = await handler(post(JSON.stringify({
    action: 'calculate', userId: 'chief-1', password: 'correct-pass',
    startDate: '2026-11-24', endDate: '2026-11-24'
  })));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.totals.cashInCents, 2500);
  assert.equal(payload.result.totals.collectionsCents, 2500);
  assert.equal(payload.result.movements.length, 1);
  assert.ok(calls.filter(call => !call.url.includes('/rpc/')).every(call => call.method === 'GET'));
  assert.ok(calls.some(call => call.url.includes('/rest/v1/student_ledger?')));
});


test('server derives expected closing and the audit snapshot instead of trusting the browser', async () => {
  const { handler, calls } = createHandler({
    users: [{ id: 'chief-1', role: 'Level 3 - Chief Admin', password_hash: 'correct-pass', data: {} }],
    sessions: [{
      id: 'session-1', business_date: '2026-11-24', currency: 'USD',
      drawer_id: 'main', opening_float: 100, status: 'OPEN'
    }],
    sources: {
      student_ledger: [{
        id: 'LEDGER-1', student_id: 'STU-1', date: '2026-11-24', type: 'payment',
        amount: 25, method: 'Cash', status: 'ACTIVE', receipt_no: 'R-1'
      }],
      transactions: [], expenses: [], payroll_history: [], payments: []
    }
  });
  const response = await handler(post(JSON.stringify({
    action: 'close', userId: 'chief-1', password: 'correct-pass',
    businessDate: '2026-11-24', currency: 'USD',
    actualClosing: 124.99,
    expectedClosing: 99999,
    snapshot: { movementCount: 0, cashInCents: 0, exceptionCount: 0 }
  })));
  assert.equal(response.status, 200);
  const rpcCall = calls.find(call => call.url.includes('/rpc/record_vault_session'));
  assert.ok(rpcCall);
  const rpcBody = JSON.parse(rpcCall.body);
  assert.equal(rpcBody.p_expected_closing, 125);
  assert.equal(rpcBody.p_actual_closing, 124.99);
  assert.equal(rpcBody.p_snapshot.movementCount, 1);
  assert.equal(rpcBody.p_snapshot.cashInCents, 2500);
  assert.equal(rpcBody.p_snapshot.exceptionCount, 0);
});

test('Vault prefers the scoped Supabase secret over the legacy service role key', async () => {
  const { handler, calls } = createHandler({
    users: [{ id: 'chief-1', role: 'Level 3 - Chief Admin', password_hash: 'correct-pass', data: {} }],
    env: { SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_scoped_key' }) }
  });
  const response = await handler(post(JSON.stringify({
    action: 'read', userId: 'chief-1', password: 'correct-pass',
    businessDate: '2026-11-24', currency: 'USD'
  })));
  assert.equal(response.status, 200);
  assert.ok(calls.every(call => call.headers.apikey === 'sb_secret_scoped_key'));
  assert.equal(calls[0].headers.Authorization, undefined);
});


test('date-range calculations scope source reads while retaining prior credit history', async () => {
  const { handler, calls } = createHandler({
    users: [{ id: 'chief-1', role: 'Level 3 - Chief Admin', password_hash: 'correct-pass', data: {} }],
    sources: { student_ledger: [], transactions: [], expenses: [], payroll_history: [], payments: [] }
  });
  const response = await handler(post(JSON.stringify({
    action: 'calculate', userId: 'chief-1', password: 'correct-pass',
    startDate: '2026-11-24', endDate: '2026-11-24'
  })));
  assert.equal(response.status, 200);
  const ledgerUrl = new URL(calls.find(call => call.url.includes('/student_ledger?')).url);
  assert.equal(ledgerUrl.searchParams.get('type'), 'in.(payment,overpayment,credit)');
  assert.equal(ledgerUrl.searchParams.get('or'), '(date.lte.2026-11-24,date.is.null)');
  const paymentsUrl = new URL(calls.find(call => call.url.includes('/payments?')).url);
  assert.equal(paymentsUrl.searchParams.get('or'), '(and(date.gte.2026-11-24,date.lte.2026-11-24),date.is.null)');
  const payrollUrl = new URL(calls.find(call => call.url.includes('/payroll_history?')).url);
  assert.equal(payrollUrl.searchParams.get('or'), '(and(payment_date.gte.2026-11-24,payment_date.lte.2026-11-24),payment_date.is.null)');
});


test('Vault authentication is blocked after the persistent throttle is reached', async () => {
  const { handler, calls } = createHandler({ rateLimitAllowed: false });
  const response = await handler(post(JSON.stringify({
    action: 'read', userId: 'chief-1', password: 'wrong-pass',
    businessDate: '2026-11-24', currency: 'USD'
  })));
  assert.equal(response.status, 429);
  const payload = await response.json();
  assert.equal(payload.retryAfterSeconds, 900);
  assert.equal(calls.filter(call => call.url.includes('/rpc/consume_vault_auth_attempt')).length, 2);
  assert.equal(calls.some(call => call.url.includes('/rest/v1/users?')), false);
});

test('successful Vault authentication clears both hashed throttle buckets', async () => {
  const { handler, calls } = createHandler({
    users: [{ id: 'chief-1', role: 'Level 3 - Chief Admin', password_hash: 'correct-pass', data: {} }],
    sessions: []
  });
  const response = await handler(post(JSON.stringify({
    action: 'read', userId: 'chief-1', password: 'correct-pass',
    businessDate: '2026-11-24', currency: 'USD'
  })));
  assert.equal(response.status, 200);
  assert.equal(calls.filter(call => call.url.includes('/rpc/clear_vault_auth_attempt')).length, 2);
});
