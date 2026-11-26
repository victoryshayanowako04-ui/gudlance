(function () {
  'use strict';

  const core = window.GudlanceVaultCore;
  if (!core) {
    console.error('[Gudlance Vault] Financial calculation core did not load.');
    return;
  }

  const state = { password: '', result: null, session: null, loading: false };
  const $ = id => document.getElementById(id);
  const formatNumber = cents => (Number(cents || 0) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  const formatMoney = cents => '$' + formatNumber(cents);
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const vaultIsOpen = () => {
    const stats = $('adminFinanceStats');
    return !!stats && stats.style.display !== 'none' && stats.style.display !== '';
  };
  const dateRange = () => ({
    startDate: $('vaultStartDate')?.value || '',
    endDate: $('vaultEndDate')?.value || ''
  });

  function injectPanel() {
    const host = $('adminFinanceStats');
    if (!host || $('vaultControlPanel')) return;
    const panel = document.createElement('section');
    panel.id = 'vaultControlPanel';
    panel.className = 'card';
    panel.style.cssText = 'margin:0 0 16px;border:1px solid #dbe4ee;border-top:4px solid #142b4a;border-radius:12px;padding:16px;background:#fff;box-shadow:0 8px 24px rgba(15,35,60,.06);';
    panel.innerHTML = [
      '<style>',
      '#vaultControlPanel *{box-sizing:border-box}#vaultControlPanel .vcp-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:14px 0}',
      '#vaultControlPanel .vcp-metric{background:#f7f9fc;border:1px solid #e7edf4;border-radius:10px;padding:12px;min-width:0}',
      '#vaultControlPanel .vcp-metric small{display:block;color:#64748b;font-size:10px;text-transform:uppercase;font-weight:800;letter-spacing:.06em;margin-bottom:7px}',
      '#vaultControlPanel .vcp-metric strong{font-size:clamp(17px,2vw,23px);color:#142b4a;overflow-wrap:anywhere}',
      '#vaultControlPanel .vcp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '#vaultControlPanel .vcp-input{width:100%;min-width:0;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#172b45;font:inherit}',
      '#vaultControlPanel .vcp-button{border:0;border-radius:8px;padding:10px 14px;background:#142b4a;color:#fff;font-weight:750;cursor:pointer}',
      '#vaultControlPanel .vcp-button:disabled{opacity:.45;cursor:not-allowed}',
      '#vaultControlPanel .vcp-button.vcp-green{background:#16834a}',
      '#vaultControlPanel .vcp-section{border:1px solid #e7edf4;border-radius:10px;padding:13px;margin-top:12px;min-width:0}',
      '#vaultControlPanel .vcp-table-wrap{overflow:auto;max-width:100%}#vaultControlPanel table{width:100%;border-collapse:collapse;min-width:580px;font-size:12px}',
      '#vaultControlPanel th{padding:9px 8px;text-align:left;color:#64748b;background:#f8fafc;font-size:10px;text-transform:uppercase;letter-spacing:.05em}',
      '#vaultControlPanel td{padding:9px 8px;border-top:1px solid #edf1f5;color:#26384e;vertical-align:top}',
      '#vaultControlPanel .vcp-status{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;background:#eef2f7;color:#334155;font-size:11px;font-weight:800}',
      '#vaultControlPanel .vcp-status.good{background:#e8f7ee;color:#14733e}#vaultControlPanel .vcp-status.warn{background:#fff5df;color:#965b00}#vaultControlPanel .vcp-status.bad{background:#fdecec;color:#a12d2d}',
      '#vaultControlPanel .vcp-muted{color:#64748b;font-size:12px}#vaultControlPanel .vcp-warn{color:#9a5b00;background:#fff8e8;border:1px solid #f6dfad;padding:10px;border-radius:8px;font-size:12px}',
      '#vaultControlPanel .vcp-danger{color:#a12d2d}#vaultControlPanel .vcp-positive{color:#14733e}',
      '@media(max-width:900px){#vaultControlPanel .vcp-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media(max-width:520px){#vaultControlPanel{padding:11px!important}#vaultControlPanel .vcp-grid{grid-template-columns:1fr 1fr;gap:7px}#vaultControlPanel .vcp-metric{padding:9px}#vaultControlPanel .vcp-metric strong{font-size:17px}#vaultControlPanel .vcp-section{padding:10px}}',
      '</style>',
      '<div class="vcp-row">',
      ' <div><div style="font-size:10px;font-weight:850;letter-spacing:.12em;color:#64748b;text-transform:uppercase">Financial control</div>',
      ' <h3 style="margin:4px 0 3px;color:#142b4a;font-size:19px">Vault Control Centre</h3>',
      ' <div class="vcp-muted">Verified movements, account separation and daily cash control</div></div>',
      ' <span id="vaultControlStatus" class="vcp-status">Waiting for data</span>',
      '</div>',
      '<div id="vaultControlMessage" class="vcp-muted" style="margin-top:12px">Choose a date range above and refresh the Vault.</div>',
      '<div class="vcp-grid">',
      ' <div class="vcp-metric"><small>Total collections</small><strong id="vcpCollections">—</strong></div>',
      ' <div class="vcp-metric"><small>Recorded expenses</small><strong id="vcpExpenses">—</strong></div>',
      ' <div class="vcp-metric"><small>Paid payroll</small><strong id="vcpPayroll">—</strong></div>',
      ' <div class="vcp-metric"><small>Net cash movement</small><strong id="vcpNetCash">—</strong></div>',
      ' <div class="vcp-metric"><small>Student credit liability</small><strong id="vcpCredit">—</strong></div>',
      '</div>',
      '<div class="vcp-section">',
      ' <div class="vcp-row"><strong style="color:#142b4a">Payment channel reconciliation</strong><span class="vcp-muted">USD only · no cross-currency addition</span></div>',
      ' <div class="vcp-table-wrap"><table><thead><tr><th>Account</th><th>Money in</th><th>Money out</th><th>Net movement</th></tr></thead><tbody id="vcpAccounts"></tbody></table></div>',
      '</div>',
      '<div id="vcpDailySession" class="vcp-section">',
      ' <div class="vcp-row"><div><strong style="color:#142b4a">Daily physical cash session</strong><div id="vcpSessionDate" class="vcp-muted">Select one date above</div></div><span id="vcpSessionStatus" class="vcp-status">Not opened</span></div>',
      ' <div id="vcpOpeningArea" style="display:none;margin-top:12px">',
      '  <div class="vcp-row" style="align-items:flex-end"><label style="flex:1;min-width:180px;font-size:12px;font-weight:750;color:#334155">Opening float (USD)<input id="vcpOpeningFloat" class="vcp-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Enter physical cash at start of day"></label>',
      '  <button id="vcpOpenButton" class="vcp-button vcp-green" type="button">Record opening float</button></div>',
      '  <div class="vcp-muted" style="margin-top:7px">The opening float is recorded once for this date. It is never carried forward automatically.</div>',
      ' </div>',
      ' <div id="vcpSessionSummary" style="display:none;margin-top:12px"></div>',
      ' <div id="vcpClosingArea" style="display:none;margin-top:12px">',
      '  <div class="vcp-row" style="align-items:flex-end"><label style="flex:1;min-width:180px;font-size:12px;font-weight:750;color:#334155">Actual physical cash counted (USD)<input id="vcpActualClosing" class="vcp-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Count the cash in the drawer"></label>',
      '  <button id="vcpCloseButton" class="vcp-button" type="button">Reconcile and close day</button></div>',
      '  <div class="vcp-muted" style="margin-top:7px">Closing records preserve the expected amount, actual count, variance and calculation snapshot.</div>',
      ' </div>',
      '</div>',
      '<div id="vcpExceptionsSection" class="vcp-section">',
      ' <div class="vcp-row"><strong style="color:#142b4a">Financial exceptions</strong><span id="vcpExceptionCount" class="vcp-status">0</span></div>',
      ' <div id="vcpExceptions" class="vcp-muted" style="margin-top:8px">No audit has been run.</div>',
      '</div>',
      '<div class="vcp-section">',
      ' <div class="vcp-row"><strong style="color:#142b4a">Financial movements</strong><span id="vcpMovementCount" class="vcp-muted">0 records</span></div>',
      ' <div class="vcp-table-wrap"><table><thead><tr><th>Date</th><th>Source</th><th>Description / Reference</th><th>Method</th><th>Flow</th><th style="text-align:right">Amount</th></tr></thead><tbody id="vcpMovements"></tbody></table></div>',
      '</div>',
      '<div class="vcp-muted" style="margin-top:11px">Reconciled records remain in history. Unknown payment methods are never assumed to be cash. ZiG is kept separate from USD.</div>'
    ].join('');
    host.insertBefore(panel, host.firstChild);
    $('vcpOpenButton').addEventListener('click', saveOpeningFloat);
    $('vcpCloseButton').addEventListener('click', closeDailySession);
  }

  async function fetchAll(table) {
    const pageSize = 1000;
    const rows = [];
    let offset = 0;
    while (true) {
      const response = await window.supabaseClient.from(table).select('*')
        .order('id', { ascending: true }).range(offset, offset + pageSize - 1);
      if (response.error) throw new Error(table + ': ' + response.error.message);
      const batch = response.data || [];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      offset += pageSize;
      if (offset > 500000) throw new Error(table + ' exceeded the safe pagination limit.');
    }
    return rows;
  }

  async function sessionRequest(action, extra) {
    const user = window.currentUser;
    if (!state.password || !user?.id) throw new Error('Unlock the Vault again to manage its daily cash session.');
    const payload = Object.assign({
      action,
      userId: String(user.id),
      password: state.password,
      businessDate: dateRange().startDate,
      currency: 'USD',
      drawerId: 'main'
    }, extra || {});
    const response = await fetch('/api/vault-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.error || 'Vault session request failed.');
    return data.session || null;
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function accountLabel(account) {
    return ({
      cash: 'Physical cash', ecocash: 'EcoCash', bank: 'Bank transfer',
      zipit: 'ZIPIT', innbucks: 'Innbucks', onemoney: 'OneMoney',
      card: 'Card / swipe', online_other: 'Other online', unclassified: 'Unclassified'
    })[account] || account;
  }

  function renderResult(result) {
    state.result = result;
    const totals = result.totals;
    setText('vcpCollections', formatMoney(totals.collectionsCents));
    setText('vcpExpenses', formatMoney(totals.expensesCents));
    setText('vcpPayroll', formatMoney(totals.payrollCents));
    setText('vcpNetCash', formatMoney(totals.netCashCents));
    setText('vcpCredit', formatMoney(totals.creditLiabilityCents));
    const netCash = $('vcpNetCash');
    if (netCash) netCash.className = totals.netCashCents < 0 ? 'vcp-danger' : 'vcp-positive';

    const accountKeys = ['cash', 'ecocash', 'bank', 'zipit', 'innbucks', 'onemoney', 'card', 'online_other'];
    const accountRows = accountKeys.map(key => {
      const account = result.accounts[key];
      const net = account.inflowCents - account.outflowCents;
      return '<tr><td>' + escapeHtml(accountLabel(key)) + '</td><td>' + formatMoney(account.inflowCents) +
        '</td><td>' + formatMoney(account.outflowCents) + '</td><td style="font-weight:800;color:' +
        (net < 0 ? '#a12d2d' : '#14733e') + '">' + formatMoney(net) + '</td></tr>';
    });
    accountRows.push('<tr><td>Unclassified</td><td>' + formatMoney(totals.unclassifiedInCents) +
      '</td><td>' + formatMoney(totals.unclassifiedOutCents) + '</td><td>Review required</td></tr>');
    if ($('vcpAccounts')) $('vcpAccounts').innerHTML = accountRows.join('');

    if ($('vcpExceptions')) {
      $('vcpExceptions').innerHTML = result.exceptions.length
        ? '<div class="vcp-warn">These records need review. The Vault does not guess their payment channel or silently discard them.</div>' +
          '<div class="vcp-table-wrap" style="margin-top:8px"><table><thead><tr><th>Code</th><th>Date</th><th>Reference</th><th>Issue</th><th>Amount</th></tr></thead><tbody>' +
          result.exceptions.map(item => '<tr><td>' + escapeHtml(item.code) + '</td><td>' + escapeHtml(item.date) +
            '</td><td>' + escapeHtml(item.ref) + '</td><td>' + escapeHtml(item.description) +
            '</td><td style="text-align:right">' + formatMoney(item.amountCents) + '</td></tr>').join('') +
          '</tbody></table></div>'
        : '<div class="vcp-positive" style="font-weight:750">No calculation exceptions found in the selected records.</div>';
    }
    setText('vcpExceptionCount', result.exceptions.length + ' flagged');
    if ($('vcpExceptionCount')) $('vcpExceptionCount').className = 'vcp-status ' + (result.exceptions.length ? 'warn' : 'good');
    setText('vcpMovementCount', result.movements.length + ' records');

    if ($('vcpMovements')) {
      $('vcpMovements').innerHTML = result.movements.length
        ? result.movements.map(item => {
          const outgoing = item.kind === 'expense' || item.kind === 'payroll';
          return '<tr><td>' + escapeHtml(item.date) + '</td><td>' + escapeHtml(item.source.replace('_', ' ')) +
            '</td><td><strong>' + escapeHtml(item.description) + '</strong><br><span class="vcp-muted">' +
            escapeHtml(item.reference) + '</span></td><td>' + escapeHtml(item.method) + '</td><td style="color:' +
            (outgoing ? '#a12d2d' : '#14733e') + ';font-weight:800">' + (outgoing ? 'Outflow' : 'Inflow') +
            '</td><td style="text-align:right;font-weight:800;color:' + (outgoing ? '#a12d2d' : '#14733e') + '">' +
            (outgoing ? '−' : '+') + formatMoney(item.amountCents) + '</td></tr>';
        }).join('')
        : '<tr><td colspan="6" class="vcp-muted">No financial movements found for this period.</td></tr>';
    }

    // Keep the established Vault summary cards synchronized with the audited calculation.
    setText('statCollectedUsd', (totals.collectionsCents / 100).toFixed(2));
    setText('vaultCashExpenses', formatNumber(result.movements
      .filter(item => item.kind === 'expense' && item.account === 'cash')
      .reduce((sum, item) => sum + item.amountCents, 0)));
    setText('vaultOnlineExpenses', formatNumber(result.movements
      .filter(item => item.kind === 'expense' && item.account !== 'cash' && item.account !== 'unclassified')
      .reduce((sum, item) => sum + item.amountCents, 0)));
    setText('vaultPayrollExpenses', formatNumber(totals.payrollCents));
    setText('vaultNetCash', formatNumber(totals.netCashCents));
    setText('vaultNetOnline', formatNumber(totals.netOnlineCents));
    setText('statOverpayUsd', (totals.overpaymentsCents / 100).toFixed(2));

    const breakdowns = window.vaultBreakdowns || {};
    ['tuitionCash', 'tuitionOnline', 'shopCash', 'shopOnline', 'eventCash', 'eventOnline',
      'overpayCash', 'overpayOnline', 'expensesCash', 'expensesOnline', 'payrollCash', 'payrollOnline', 'overpayment']
      .forEach(key => { breakdowns[key] = []; });
    result.movements.forEach(item => {
      const row = { date: item.date, desc: item.description, ref: item.reference, method: item.method, amount: item.amountCents / 100 };
      const online = item.account && item.account !== 'cash' && item.account !== 'unclassified';
      if (item.category === 'tuition' && (item.account === 'cash' || online)) breakdowns[item.account === 'cash' ? 'tuitionCash' : 'tuitionOnline'].push(row);
      else if (item.category === 'shop' && (item.account === 'cash' || online)) breakdowns[item.account === 'cash' ? 'shopCash' : 'shopOnline'].push(row);
      else if (item.category === 'event' && (item.account === 'cash' || online)) breakdowns[item.account === 'cash' ? 'eventCash' : 'eventOnline'].push(row);
      else if (item.category === 'overpayment') {
        if (item.account === 'cash' || online) breakdowns[item.account === 'cash' ? 'overpayCash' : 'overpayOnline'].push(row);
        breakdowns.overpayment.push(row);
      } else if (item.kind === 'payroll' && (item.account === 'cash' || online)) {
        breakdowns[item.account === 'cash' ? 'payrollCash' : 'payrollOnline'].push(row);
      } else if (item.kind === 'expense' && (item.account === 'cash' || online)) {
        breakdowns[item.account === 'cash' ? 'expensesCash' : 'expensesOnline'].push(row);
      }
    });
    window.vaultBreakdowns = breakdowns;
    updateDailySession(result);
    updateVaultStatus(result);
  }

  function updateVaultStatus(result) {
    const badge = $('vaultControlStatus');
    const message = $('vaultControlMessage');
    const range = dateRange();
    if (message) message.textContent = (range.startDate || 'All available history') + ' → ' +
      (range.endDate || 'Latest recorded date') + ' · ' + result.movements.length +
      ' movements · ' + result.exceptions.length + ' exceptions';
    if (!badge) return;
    badge.textContent = result.exceptions.length ? 'Review required · ' + result.exceptions.length : 'Calculation checks passed';
    badge.className = 'vcp-status ' + (result.exceptions.length ? 'warn' : 'good');
  }

  async function updateDailySession(result) {
    const range = dateRange();
    const daily = !!range.startDate && range.startDate === range.endDate;
    if (!$('vcpDailySession')) return;
    $('vcpDailySession').style.display = daily ? 'block' : 'none';
    if (!daily) {
      state.session = null;
      return;
    }
    setText('vcpSessionDate', 'Business date: ' + range.startDate + ' · USD main cash drawer');
    try {
      state.session = await sessionRequest('read');
      renderSession(result);
    } catch (error) {
      state.session = null;
      setText('vcpSessionStatus', 'Session service unavailable');
      if ($('vcpSessionStatus')) $('vcpSessionStatus').className = 'vcp-status warn';
      if ($('vcpSessionSummary')) {
        $('vcpSessionSummary').style.display = 'block';
        $('vcpSessionSummary').innerHTML = '<div class="vcp-warn">' + escapeHtml(error.message) +
          ' Existing payment and expense records have not been changed. Daily opening floats cannot be saved until the session service is available.</div>';
      }
      if ($('vcpOpeningArea')) $('vcpOpeningArea').style.display = 'none';
      if ($('vcpClosingArea')) $('vcpClosingArea').style.display = 'none';
    }
  }

  function renderSession(result) {
    const session = state.session;
    if (!session) {
      setText('vcpSessionStatus', 'Opening float required');
      if ($('vcpSessionStatus')) $('vcpSessionStatus').className = 'vcp-status warn';
      if ($('vcpOpeningArea')) $('vcpOpeningArea').style.display = 'block';
      if ($('vcpClosingArea')) $('vcpClosingArea').style.display = 'none';
      if ($('vcpSessionSummary')) $('vcpSessionSummary').style.display = 'none';
      if ($('vcpOpeningFloat')) $('vcpOpeningFloat').disabled = false;
      if ($('vcpOpenButton')) $('vcpOpenButton').disabled = false;
      return;
    }
    if ($('vcpOpeningFloat')) $('vcpOpeningFloat').value = Number(session.opening_float).toFixed(2);
    if ($('vcpOpeningArea')) $('vcpOpeningArea').style.display = 'none';
    const closed = String(session.status).toUpperCase() === 'CLOSED';
    const expected = closed ? Number(session.expected_closing) :
      Number(session.opening_float) + result.totals.netCashCents / 100;
    if ($('vcpSessionSummary')) {
      $('vcpSessionSummary').style.display = 'block';
      $('vcpSessionSummary').innerHTML = '<div class="vcp-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin:0">' +
        '<div class="vcp-metric"><small>Opening float</small><strong>' + formatMoney(core.cents(session.opening_float)) + '</strong></div>' +
        '<div class="vcp-metric"><small>Expected closing</small><strong>' + formatMoney(core.cents(expected)) + '</strong></div>' +
        '<div class="vcp-metric"><small>' + (closed ? 'Actual closing' : 'Net movement') + '</small><strong>' +
        (closed ? formatMoney(core.cents(session.actual_closing)) : formatMoney(result.totals.netCashCents)) + '</strong></div></div>' +
        (closed ? '<div class="' + (Number(session.variance) === 0 ? 'vcp-positive' : 'vcp-danger') +
          '" style="font-weight:850;margin-top:10px">Closing variance: ' + formatMoney(core.cents(session.variance)) +
          (Number(session.variance) === 0 ? ' · Balanced' : ' · Difference requires investigation') + '</div>' :
          '<div class="vcp-muted" style="margin-top:8px">Opening float is locked. Record the actual drawer count when the day is finished.</div>');
    }
    setText('vcpSessionStatus', closed ? 'Day closed' : 'Opening float recorded');
    if ($('vcpSessionStatus')) $('vcpSessionStatus').className = 'vcp-status ' + (closed ? 'good' : 'warn');
    if ($('vcpClosingArea')) $('vcpClosingArea').style.display = closed ? 'none' : 'block';
  }

  async function saveOpeningFloat() {
    const button = $('vcpOpenButton');
    const amount = Number($('vcpOpeningFloat')?.value);
    if (!Number.isFinite(amount) || amount < 0) return alert('Enter a valid opening float.');
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    try {
      state.session = await sessionRequest('open', { openingFloat: amount });
      renderSession(state.result);
      alert('Opening float recorded for ' + dateRange().startDate + '.');
    } catch (error) {
      alert('Opening float was not saved: ' + error.message);
    } finally {
      if (button) { button.disabled = false; button.textContent = 'Record opening float'; }
    }
  }

  async function closeDailySession() {
    const button = $('vcpCloseButton');
    if (!state.session || !state.result) return alert('Record the opening float and refresh the Vault first.');
    const actual = Number($('vcpActualClosing')?.value);
    if (!Number.isFinite(actual) || actual < 0) return alert('Enter the actual cash count.');
    const expected = Number(state.session.opening_float) + state.result.totals.netCashCents / 100;
    if (button) { button.disabled = true; button.textContent = 'Reconciling…'; }
    try {
      state.session = await sessionRequest('close', {
        expectedClosing: expected,
        actualClosing: actual,
        snapshot: {
          calculatedAt: new Date().toISOString(),
          startDate: state.result.startDate,
          endDate: state.result.endDate,
          collectionsCents: state.result.totals.collectionsCents,
          cashInCents: state.result.totals.cashInCents,
          cashOutCents: state.result.totals.cashOutCents,
          netCashCents: state.result.totals.netCashCents,
          expensesCents: state.result.totals.expensesCents,
          payrollCents: state.result.totals.payrollCents,
          overpaymentsCents: state.result.totals.overpaymentsCents,
          creditLiabilityCents: state.result.totals.creditLiabilityCents,
          exceptionCount: state.result.exceptions.length,
          movementCount: state.result.movements.length
        }
      });
      renderSession(state.result);
      if (state.result.exceptions.length) {
        alert('The day was closed, but ' + state.result.exceptions.length +
          ' financial exceptions remain unresolved. It is not marked fully verified.');
      } else if (Number(state.session.variance) === 0) {
        alert('Vault closed and balanced.');
      } else {
        alert('Vault closed with a variance of ' + formatMoney(core.cents(state.session.variance)) +
          '. Investigate the difference.');
      }
    } catch (error) {
      alert('Vault closing was not saved: ' + error.message);
    } finally {
      if (button) { button.disabled = false; button.textContent = 'Reconcile and close day'; }
    }
  }

  async function refreshFinancialVault(options) {
    if (!vaultIsOpen() || state.loading) return;
    if (!window.supabaseClient) {
      setText('vaultControlMessage', 'Supabase is not connected. No figures have been verified.');
      return;
    }
    state.loading = true;
    try {
      injectPanel();
      const datasets = await Promise.all([
        fetchAll('student_ledger'),
        fetchAll('transactions'),
        fetchAll('expenses'),
        fetchAll('payroll_history')
      ]);
      const range = dateRange();
      const result = core.calculateVaultFinancials({
        startDate: range.startDate,
        endDate: range.endDate,
        ledger: datasets[0],
        transactions: datasets[1],
        expenses: datasets[2],
        payroll: datasets[3]
      });
      renderResult(result);
      return result;
    } catch (error) {
      setText('vaultControlStatus', 'Calculation failed');
      if ($('vaultControlStatus')) $('vaultControlStatus').className = 'vcp-status bad';
      setText('vaultControlMessage', 'The calculation could not be completed. Do not rely on previous totals. ' + (error.message || error));
      if (!options?.silent) alert('Vault calculation failed: ' + (error.message || error));
      return null;
    } finally {
      state.loading = false;
    }
  }

  function clearSensitivePanel() {
    state.password = '';
    state.session = null;
    state.result = null;
    ['vcpCollections', 'vcpExpenses', 'vcpPayroll', 'vcpNetCash', 'vcpCredit',
      'vcpMovementCount', 'vcpExceptionCount', 'vaultControlMessage'].forEach(id => setText(id, '—'));
    setText('vaultControlStatus', 'Vault locked');
    setText('vcpSessionStatus', 'Not opened');
    setText('vcpSessionDate', 'Select one date above');
    ['vcpAccounts', 'vcpMovements', 'vcpExceptions', 'vcpSessionSummary'].forEach(id => {
      const element = $(id);
      if (element) element.innerHTML = '';
    });
    ['vcpOpeningFloat', 'vcpActualClosing'].forEach(id => {
      const element = $(id);
      if (element) element.value = '';
    });
    ['vcpOpeningArea', 'vcpClosingArea', 'vcpSessionSummary'].forEach(id => {
      const element = $(id);
      if (element) element.style.display = 'none';
    });
  }

  function installLegacyIntegration() {
    const originalCalculate = window.calculateVaultStats;
    if (typeof originalCalculate === 'function' && !originalCalculate.__vaultFinancialWrapped) {
      const wrapped = async function () {
        const result = await originalCalculate.apply(this, arguments);
        if (vaultIsOpen()) await refreshFinancialVault({ silent: true });
        return result;
      };
      wrapped.__vaultFinancialWrapped = true;
      window.calculateVaultStats = wrapped;
    }

    const originalShowBreakdown = window.showVaultBreakdown;
    if (typeof originalShowBreakdown === 'function' && !originalShowBreakdown.__vaultFinancialWrapped) {
      const wrappedShow = function (categoryKey, title, formulaText) {
        if (categoryKey !== 'netCash' && categoryKey !== 'netOnline') return originalShowBreakdown.apply(this, arguments);
        const breakdowns = window.vaultBreakdowns || {};
        const expenseKey = categoryKey === 'netCash' ? 'expensesCash' : 'expensesOnline';
        const payrollKey = categoryKey === 'netCash' ? 'payrollCash' : 'payrollOnline';
        const original = breakdowns[expenseKey] || [];
        breakdowns[expenseKey] = original.concat(breakdowns[payrollKey] || []);
        try { return originalShowBreakdown.apply(this, arguments); }
        finally { breakdowns[expenseKey] = original; }
      };
      wrappedShow.__vaultFinancialWrapped = true;
      window.showVaultBreakdown = wrappedShow;
    }

    const originalLock = window.lockAdminFinance;
    if (typeof originalLock === 'function' && !originalLock.__vaultFinancialWrapped) {
      const wrappedLock = function () {
        const result = originalLock.apply(this, arguments);
        clearSensitivePanel();
        return result;
      };
      wrappedLock.__vaultFinancialWrapped = true;
      window.lockAdminFinance = wrappedLock;
    }

    const originalLogout = window.logout;
    if (typeof originalLogout === 'function' && !originalLogout.__vaultFinancialWrapped) {
      const wrappedLogout = function () {
        if (vaultIsOpen() && typeof window.lockAdminFinance === 'function') window.lockAdminFinance();
        clearSensitivePanel();
        return originalLogout.apply(this, arguments);
      };
      wrappedLogout.__vaultFinancialWrapped = true;
      window.logout = wrappedLogout;
    }
  }

  window.setVaultSessionPassword = password => { state.password = String(password || ''); };
  window.refreshFinancialVault = refreshFinancialVault;
  injectPanel();
  installLegacyIntegration();
  if (window.currentUser && vaultIsOpen()) refreshFinancialVault({ silent: true });
})();