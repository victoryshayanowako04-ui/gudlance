const baseCorsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Vary': 'Origin',
  'X-Content-Type-Options': 'nosniff'
};

const isAllowedOrigin = value => {
  if (!value) return true;
  try {
    const origin = new URL(value);
    return origin.protocol === 'https:' &&
      (origin.hostname === 'gudlance.pages.dev' || origin.hostname.endsWith('.gudlance.pages.dev'));
  } catch (_) { return false; }
};

const corsHeadersFor = origin => ({
  ...baseCorsHeaders,
  ...(origin && isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin } : {})
});

const json = (status, payload, origin = '') => new Response(JSON.stringify(payload), {
  status,
  headers: { ...corsHeadersFor(origin), 'Content-Type': 'application/json; charset=utf-8' }
});

const isDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(String(value) + 'T00:00:00.000Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const money = value => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 100000000000) return null;
  return Math.round((number + Number.EPSILON) * 100) / 100;
};

const safeEqual = (leftValue, rightValue) => {
  const encoder = new TextEncoder();
  const left = encoder.encode(String(leftValue || ''));
  const right = encoder.encode(String(rightValue || ''));
  if (!left.length || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
};

function getServerKey() {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const secretMap = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretMap) {
    try {
      const parsed = JSON.parse(secretMap);
      if (parsed && parsed.default) return parsed.default;
    } catch (_) {}
  }
  return '';
}

async function supabaseRequest(path, options) {
  const baseUrl = String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  const serverKey = getServerKey();
  if (!baseUrl || !serverKey) {
    const error = new Error('Vault session service is not configured.');
    error.status = 503;
    throw error;
  }
  const headers = {
    apikey: serverKey,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...((options && options.headers) || {})
  };
  // New sb_secret keys are sent only as apikey. Legacy service_role keys are JWTs.
  if (!serverKey.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + serverKey;
  const response = await fetch(baseUrl + '/rest/v1/' + path, {
    ...(options || {}),
    headers
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error('Vault storage request failed.');
    error.status = response.status >= 500 ? 503 : 400;
    throw error;
  }
  return body ? JSON.parse(body) : null;
}

async function verifyChiefAdmin(userId, password) {
  const users = await supabaseRequest(
    'users?select=id,role,data,password_hash&id=eq.' + encodeURIComponent(userId) + '&limit=1'
  );
  const user = Array.isArray(users) ? users[0] : null;
  if (!user) {
    const error = new Error('Vault access could not be verified.');
    error.status = 401;
    throw error;
  }
  let data = user.data || {};
  if (typeof data === 'string') {
    try { data = JSON.parse(data || '{}'); } catch (_) { data = {}; }
  }
  const role = String(user.role || data.role || '').toLowerCase();
  if (!role.includes('level 3') && role !== 'chief admin') {
    const error = new Error('Only Chief Admin accounts can manage daily Vault sessions.');
    error.status = 403;
    throw error;
  }
  const storedPassword = user.password_hash || data.pass || data.password;
  if (!safeEqual(password, storedPassword)) {
    const error = new Error('Vault password is incorrect.');
    error.status = 401;
    throw error;
  }
  return user;
}

Deno.serve(async request => {
  const origin = request.headers.get('Origin') || '';
  const respond = (status, payload) => json(status, payload, origin);
  if (request.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) return new Response('Forbidden', { status: 403, headers: baseCorsHeaders });
    return new Response('ok', { headers: corsHeadersFor(origin) });
  }
  if (origin && !isAllowedOrigin(origin)) return respond(403, { error: 'This origin is not allowed to manage the Gudlance Vault.' });
  if (request.method !== 'POST') return respond(405, { error: 'Method Not Allowed' });

  try {
    const rawBody = await request.text();
    if (rawBody.length > 120000) return respond(413, { error: 'Vault request is too large.' });
    const body = JSON.parse(rawBody || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(400, { error: 'Invalid Vault request.' });
    const action = String(body.action || '').toLowerCase();
    const userId = String(body.userId || '').trim();
    const password = String(body.password || '');
    const businessDate = String(body.businessDate || '');
    const currency = String(body.currency || 'USD');
    const drawerId = String(body.drawerId || 'main').trim() || 'main';

    if (!userId || !password || userId.length > 128 || password.length > 256) {
      return respond(400, { error: 'Vault authentication is required.' });
    }
    if (!isDate(businessDate)) return respond(400, { error: 'Select a valid business date.' });
    if (!['USD', 'ZiG'].includes(currency)) return respond(400, { error: 'Unsupported Vault currency.' });
    if (!['read', 'open', 'close'].includes(action)) return respond(400, { error: 'Unsupported Vault action.' });
    if (drawerId.length > 80) return respond(400, { error: 'Invalid cash drawer.' });

    const user = await verifyChiefAdmin(userId, password);

    if (action === 'read') {
      const rows = await supabaseRequest(
        'vault_daily_sessions?select=*&business_date=eq.' + businessDate +
          '&currency=eq.' + encodeURIComponent(currency) +
          '&drawer_id=eq.' + encodeURIComponent(drawerId) + '&limit=1'
      );
      return respond(200, { session: Array.isArray(rows) ? rows[0] || null : null });
    }

    if (action === 'open') {
      const openingFloat = money(body.openingFloat);
      if (openingFloat === null || openingFloat < 0) {
        return respond(400, { error: 'Enter a valid opening float of zero or more.' });
      }
      const session = await supabaseRequest('rpc/record_vault_session', {
        method: 'POST',
        body: JSON.stringify({
          p_action: 'OPEN',
          p_business_date: businessDate,
          p_currency: currency,
          p_drawer_id: drawerId,
          p_opening_float: openingFloat,
          p_expected_closing: null,
          p_actual_closing: null,
          p_snapshot: {},
          p_actor_id: String(user.id)
        })
      });
      return respond(200, { session });
    }

    const expectedClosing = money(body.expectedClosing);
    const actualClosing = money(body.actualClosing);
    if (expectedClosing === null || actualClosing === null || actualClosing < 0) {
      return respond(400, { error: 'Enter a valid actual closing cash count.' });
    }
    const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : {};
    if (JSON.stringify(snapshot).length > 100000) {
      return respond(400, { error: 'The reconciliation snapshot is too large.' });
    }
    const session = await supabaseRequest('rpc/record_vault_session', {
      method: 'POST',
      body: JSON.stringify({
        p_action: 'CLOSE',
        p_business_date: businessDate,
        p_currency: currency,
        p_drawer_id: drawerId,
        p_opening_float: null,
        p_expected_closing: expectedClosing,
        p_actual_closing: actualClosing,
        p_snapshot: snapshot,
        p_actor_id: String(user.id)
      })
    });
    return respond(200, { session });
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('Vault session service error:', error.message || error);
    return respond(status, {
      error: status >= 500 ? 'Vault session service is temporarily unavailable.' : error.message
    });
  }
});