import './vault-financial-core.js';

const baseCorsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Vary': 'Origin',
  'X-Content-Type-Options': 'nosniff'
};

const configuredVaultOrigins = String(Deno.env.get('GUDLANCE_VAULT_ALLOWED_ORIGINS') || '')
  .split(',')
  .map(value => {
    try { return new URL(value.trim()).origin; } catch (_) { return ''; }
  })
  .filter(Boolean);

const isAllowedOrigin = value => {
  if (!value) return true;
  try {
    const origin = new URL(value);
    return origin.protocol === 'https:' && (
      origin.hostname === 'gudlance.pages.dev' ||
      origin.hostname.endsWith('.gudlance.pages.dev') ||
      configuredVaultOrigins.includes(origin.origin)
    );
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
  const secretMap = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretMap) {
    try {
      const parsed = JSON.parse(secretMap);
      if (parsed && parsed.default) return parsed.default;
    } catch (_) {}
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function consumeVaultAuthThrottle(userId, request) {
  const forwarded = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const clientIp = request.headers.get('cf-connecting-ip') || forwarded || 'unknown';
  const keys = [
    await sha256Hex('ip:' + clientIp),
    await sha256Hex('user:' + userId + ':' + clientIp)
  ];
  let retryAfterSeconds = 0;
  for (const keyHash of keys) {
    const response = await supabaseRequest('rpc/consume_vault_auth_attempt', {
      method: 'POST',
      body: JSON.stringify({
        p_key_hash: keyHash,
        p_max_attempts: 6,
        p_window_seconds: 300,
        p_block_seconds: 900
      })
    });
    const bucket = Array.isArray(response) ? response[0] : response;
    if (!bucket || bucket.allowed !== true) {
      retryAfterSeconds = Math.max(retryAfterSeconds, Number(bucket?.retry_after_seconds) || 900);
    }
  }
  return { allowed: retryAfterSeconds === 0, retryAfterSeconds, keys };
}

async function clearVaultAuthThrottle(keys) {
  await Promise.all((keys || []).map(keyHash => supabaseRequest('rpc/clear_vault_auth_attempt', {
    method: 'POST',
    body: JSON.stringify({ p_key_hash: keyHash })
  })));
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


const VAULT_SOURCE_COLUMNS = {
  student_ledger: 'id,student_id,date,type,description,amount,method,status,receipt_no,breakdown,is_credit_backed,processed_by,credit_used,payment_notes,zig,reconciled',
  transactions: 'id,student_id,date,type,amount,description,receipt_no,status,category,total,reconciled,paymentmethod,item,usdpaid,zigpaid,discount,is_credit_backed,processed_by,credit_applied_amount,payment_details,notes',
  expenses: 'id,created_at,description,amount,date,data,payment_method,category,signed_by,status',
  payroll_history: 'id,teacher_id,amount,payment_date,payroll_period,payment_method,status,reference_number,expenses,notes',
  payments: 'id,receipt_no,student_id,amount,date,method,status,category,notes,zig,reconciled'
};

async function fetchAllVaultRows(table, filters = {}) {
  const columns = VAULT_SOURCE_COLUMNS[table];
  if (!columns) throw new Error('Unsupported Vault source table.');
  const pageSize = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      select: columns,
      order: 'id.asc',
      limit: String(pageSize),
      offset: String(offset)
    });
    Object.entries(filters || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    });
    const batch = await supabaseRequest(table + '?' + params.toString());
    if (!Array.isArray(batch)) throw new Error('Unexpected response from Vault source table: ' + table);
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    if (offset > 500000) throw new Error('Vault source table exceeded the safe pagination limit: ' + table);
  }
  return rows;
}

function dateRangeFilters(column, startDate, endDate) {
  const conditions = [];
  if (startDate) conditions.push(column + '.gte.' + startDate);
  if (endDate) conditions.push(column + '.lte.' + endDate);
  if (!conditions.length) return {};
  const rangeCondition = conditions.length === 2
    ? 'and(' + conditions.join(',') + ')'
    : conditions[0];
  // Keep undated rows visible so the engine can flag them instead of silently hiding them.
  return { or: '(' + rangeCondition + ',' + column + '.is.null)' };
}

async function calculateVaultReport(startDate, endDate) {
  const core = globalThis.GudlanceVaultCore;
  if (!core || typeof core.calculateVaultFinancials !== 'function') {
    const error = new Error('Vault calculation engine is unavailable.');
    error.status = 503;
    throw error;
  }
  const ledgerFilters = { type: 'in.(payment,overpayment,credit)' };
  if (endDate) ledgerFilters.or = '(date.lte.' + endDate + ',date.is.null)';
  const [ledger, transactions, expenses, payroll, payments] = await Promise.all([
    fetchAllVaultRows('student_ledger', ledgerFilters),
    fetchAllVaultRows('transactions', dateRangeFilters('date', startDate, endDate)),
    // Keep date-filtered expenses plus undated legacy rows whose date may live
    // inside the JSON data column. This avoids rescanning the entire expense history
    // for a single-day Vault view without silently dropping older legacy records.
    fetchAllVaultRows('expenses', dateRangeFilters('date', startDate, endDate)),
    fetchAllVaultRows('payroll_history', dateRangeFilters('payment_date', startDate, endDate)),
    fetchAllVaultRows('payments', dateRangeFilters('date', startDate, endDate))
  ]);
  return core.calculateVaultFinancials({
    startDate, endDate,
    ledger, transactions, expenses, payroll, payments
  });
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
    if (!String(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
      return respond(415, { error: 'Vault requests must use JSON.' });
    }
    const rawBody = await request.text();
    if (rawBody.length > 120000) return respond(413, { error: 'Vault request is too large.' });
    let body;
    try { body = JSON.parse(rawBody || '{}'); }
    catch (_) { return respond(400, { error: 'Invalid JSON request.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(400, { error: 'Invalid Vault request.' });
    const action = String(body.action || '').toLowerCase();
    const userId = String(body.userId || '').trim();
    const password = String(body.password || '');
    const businessDate = String(body.businessDate || '');
    const currency = String(body.currency || 'USD');
    const drawerId = String(body.drawerId || 'main').trim() || 'main';
    const startDate = String(body.startDate || '');
    const endDate = String(body.endDate || '');

    if (!userId || !password || userId.length > 128 || password.length > 256) {
      return respond(400, { error: 'Vault authentication is required.' });
    }
    if (!['read', 'open', 'close', 'calculate'].includes(action)) return respond(400, { error: 'Unsupported Vault action.' });
    if (action !== 'calculate' && !isDate(businessDate)) return respond(400, { error: 'Select a valid business date.' });
    if (action === 'calculate') {
      if ((startDate && !isDate(startDate)) || (endDate && !isDate(endDate))) {
        return respond(400, { error: 'Select valid report dates.' });
      }
      if (startDate && endDate && startDate > endDate) {
        return respond(400, { error: 'The report start date must be on or before its end date.' });
      }
    }
    if (action !== 'calculate' && !['USD', 'ZiG'].includes(currency)) return respond(400, { error: 'Unsupported Vault currency.' });
    if ((action === 'open' || action === 'close') && currency !== 'USD') {
      return respond(400, { error: 'ZiG drawer opening and closing are not enabled yet. ZiG activity remains separate from USD cash.' });
    }
    if (drawerId.length > 80) return respond(400, { error: 'Invalid cash drawer.' });

    const throttle = await consumeVaultAuthThrottle(userId, request);
    if (!throttle.allowed) {
      return respond(429, {
        error: 'Too many unsuccessful Vault access attempts. Try again after the temporary security lock expires.',
        retryAfterSeconds: throttle.retryAfterSeconds
      });
    }

    let user;
    try {
      user = await verifyChiefAdmin(userId, password);
    } catch (error) {
      if ((Number(error.status) || 500) >= 500) {
        try { await clearVaultAuthThrottle(throttle.keys); } catch (_) {}
      }
      throw error;
    }
    try { await clearVaultAuthThrottle(throttle.keys); }
    catch (error) { console.error('Vault auth throttle reset failed:', error.message || error); }

    if (action === 'calculate') {
      const result = await calculateVaultReport(startDate, endDate);
      return respond(200, { result });
    }

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

    const actualClosing = money(body.actualClosing);
    if (actualClosing === null || actualClosing < 0) {
      return respond(400, { error: 'Enter a valid actual closing cash count.' });
    }

    // The browser supplies only the physical count. Expected cash and the audit
    // snapshot are rebuilt here from the saved opening float and live source records.
    const sessionRows = await supabaseRequest(
      'vault_daily_sessions?select=id,business_date,currency,drawer_id,opening_float,status&business_date=eq.' + businessDate +
        '&currency=eq.' + encodeURIComponent(currency) +
        '&drawer_id=eq.' + encodeURIComponent(drawerId) + '&limit=1'
    );
    const currentSession = Array.isArray(sessionRows) ? sessionRows[0] : null;
    if (!currentSession) {
      return respond(409, { error: 'Record the opening float before closing this business day.' });
    }
    const openingFloat = money(currentSession.opening_float);
    if (openingFloat === null || openingFloat < 0) {
      return respond(409, { error: 'The saved opening float is invalid. The day cannot be closed.' });
    }

    const report = await calculateVaultReport(businessDate, businessDate);
    if (!report || !report.totals || !Array.isArray(report.movements) || !Array.isArray(report.exceptions)) {
      const error = new Error('The server could not build a complete closing snapshot.');
      error.status = 503;
      throw error;
    }
    const sessionExceptions = report.exceptions.filter(item => !item.currency || item.currency === currency);
    const expectedClosing = money(openingFloat + Number(report.totals.netCashCents || 0) / 100);
    if (expectedClosing === null || expectedClosing < 0) {
      const error = new Error('The server calculated an invalid expected closing balance.');
      error.status = 503;
      throw error;
    }
    const snapshot = {
      calculatedAt: new Date().toISOString(),
      startDate: businessDate,
      endDate: businessDate,
      openingFloat,
      collectionsCents: report.totals.collectionsCents,
      cashInCents: report.totals.cashInCents,
      cashOutCents: report.totals.cashOutCents,
      netCashCents: report.totals.netCashCents,
      expensesCents: report.totals.expensesCents,
      payrollCents: report.totals.payrollCents,
      overpaymentsCents: report.totals.overpaymentsCents,
      creditLiabilityCents: report.totals.creditLiabilityCents,
      exceptionCount: sessionExceptions.length,
      movementCount: report.movements.length,
      unclassifiedInCents: report.totals.unclassifiedInCents,
      unclassifiedOutCents: report.totals.unclassifiedOutCents,
      netOnlineCents: report.totals.netOnlineCents,
      movementRefs: report.movements.slice(0, 500).map(item => ({
        source: item.source, sourceId: item.sourceId, reference: item.reference,
        account: item.account, kind: item.kind, amountCents: item.amountCents
      })),
      movementRefsTruncated: report.movements.length > 500,
      exceptionRefs: sessionExceptions.slice(0, 100).map(item => ({
        code: item.code, date: item.date, reference: item.ref, amountCents: item.amountCents
      })),
      exceptionRefsTruncated: sessionExceptions.length > 100
    };
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