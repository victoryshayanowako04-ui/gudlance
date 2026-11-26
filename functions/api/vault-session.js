const json = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});

const isDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(String(value) + 'T00:00:00.000Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const money = value => {
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

async function supabaseRequest(env, path, options) {
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRoleKey) {
    const error = new Error('Vault session service is not configured.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(baseUrl + '/rest/v1/' + path, {
    ...(options || {}),
    headers: {
      apikey: serviceRoleKey,
      Authorization: 'Bearer ' + serviceRoleKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...((options && options.headers) || {})
    }
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error('Vault storage request failed.');
    error.status = response.status >= 500 ? 503 : 400;
    throw error;
  }
  return body ? JSON.parse(body) : null;
}

async function verifyChiefAdmin(env, userId, password) {
  const users = await supabaseRequest(
    env,
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

export async function onRequestPost(context) {
  try {
    const request = context.request;
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) {
      return json(403, { error: 'Cross-origin Vault requests are not allowed.' });
    }

    const body = await request.json();
    const action = String(body.action || '').toLowerCase();
    const userId = String(body.userId || '').trim();
    const password = String(body.password || '');
    const businessDate = String(body.businessDate || '');
    const currency = String(body.currency || 'USD') === 'ZiG' ? 'ZiG' : 'USD';
    const drawerId = String(body.drawerId || 'main').trim() || 'main';

    if (!userId || !password) return json(400, { error: 'Vault authentication is required.' });
    if (!isDate(businessDate)) return json(400, { error: 'Select a valid business date.' });
    if (!['read', 'open', 'close'].includes(action)) return json(400, { error: 'Unsupported Vault action.' });
    if (drawerId.length > 80) return json(400, { error: 'Invalid cash drawer.' });

    const user = await verifyChiefAdmin(context.env, userId, password);

    if (action === 'read') {
      const rows = await supabaseRequest(
        context.env,
        'vault_daily_sessions?select=*&business_date=eq.' + businessDate +
          '&currency=eq.' + encodeURIComponent(currency) +
          '&drawer_id=eq.' + encodeURIComponent(drawerId) + '&limit=1'
      );
      return json(200, { session: Array.isArray(rows) ? rows[0] || null : null });
    }

    if (action === 'open') {
      const openingFloat = money(body.openingFloat);
      if (openingFloat === null || openingFloat < 0) {
        return json(400, { error: 'Enter a valid opening float of zero or more.' });
      }
      const session = await supabaseRequest(context.env, 'rpc/record_vault_session', {
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
      return json(200, { session });
    }

    const expectedClosing = money(body.expectedClosing);
    const actualClosing = money(body.actualClosing);
    if (expectedClosing === null || actualClosing === null || actualClosing < 0) {
      return json(400, { error: 'Enter a valid actual closing cash count.' });
    }
    const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : {};
    if (JSON.stringify(snapshot).length > 30000) {
      return json(400, { error: 'The reconciliation snapshot is too large.' });
    }
    const session = await supabaseRequest(context.env, 'rpc/record_vault_session', {
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
    return json(200, { session });
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('Vault session service error:', error);
    return json(status, {
      error: status >= 500 ? 'Vault session service is temporarily unavailable.' : error.message
    });
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  return onRequestPost(context);
}