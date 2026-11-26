const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../supabase/functions/vault-session/index.ts'),
  'utf8'
);
const allowedOrigin = 'https://feature-vault-financial-reco.gudlance.pages.dev';

function createHandler(options = {}) {
  let handler = null;
  const calls = [];
  const users = options.users || [];
  const sessions = options.sessions || [];
  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-server-key',
    ...(options.env || {})
  };
  const mockFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: String(url), method, headers: init.headers || {} });
    if (String(url).includes('/rest/v1/users?')) {
      return new Response(JSON.stringify(users), { status: 200 });
    }
    if (String(url).includes('/rest/v1/vault_daily_sessions?')) {
      return new Response(JSON.stringify(sessions), { status: 200 });
    }
    throw new Error('Unexpected Vault test request: ' + url);
  };
  vm.runInNewContext(source, {
    Deno: {
      env: { get: name => env[name] || '' },
      serve: callback => { handler = callback; }
    },
    fetch: mockFetch,
    TextEncoder,
    URL,
    Response,
    Request,
    Headers,
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
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET']);
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
