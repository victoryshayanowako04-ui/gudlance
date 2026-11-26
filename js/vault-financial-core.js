(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GudlanceVaultCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INVALID_STATUSES = new Set(['VOID', 'VOIDED', 'REVERSAL', 'FAILED', 'CANCELLED', 'CANCELED', 'DELETED']);
  const PAID_STATUSES = new Set(['ACTIVE', 'PAID', 'COMPLETED', 'SUCCESS', 'SUCCEEDED']);
  const cents = value => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) : 0;
  };
  const money = value => cents(value) / 100;
  const isoDate = value => {
    if (!value) return '';
    const text = String(value).trim();
    const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
  };
  const parseData = value => {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (_) { return {}; }
    }
    return {};
  };
  const isValidStatus = value => !INVALID_STATUSES.has(String(value || 'ACTIVE').trim().toUpperCase());
  const isPaidStatus = value => PAID_STATUSES.has(String(value || '').trim().toUpperCase());
  const classifyMethod = value => {
    const method = String(value || '').trim().toLowerCase();
    if (!method || ['n/a', 'not specified', 'not recorded', 'unknown'].includes(method)) return 'unclassified';
    if (method.includes('advance credit') || method === 'credit' || method.includes('account credit')) return 'credit';
    if (/[+,/]/.test(method) && !method.includes('cash usd')) return 'unclassified';
    if (method.includes('cash')) return 'cash';
    if (method.includes('ecocash')) return 'ecocash';
    if (method.includes('innbucks')) return 'innbucks';
    if (method.includes('zipit')) return 'zipit';
    if (method.includes('onemoney') || method.includes('one money')) return 'onemoney';
    if (method.includes('bank') || method.includes('transfer')) return 'bank';
    if (method.includes('swipe') || method.includes('card')) return 'card';
    if (method.includes('online') || method.includes('paynow')) return 'online_other';
    return 'unclassified';
  };
  const categoryFor = (description, rowType) => {
    const text = String(description || '').toLowerCase();
    if (rowType === 'overpayment' || text.includes('overpayment') || text.includes('account credit') || text.includes('advance credit')) return 'overpayment';
    if (text.includes('shop') || text.includes('uniform') || text.includes('tracksuit') || text.includes('stock purchase')) return 'shop';
    if (text.includes('event') || text.includes('trip') || text.includes('graduation') || text.includes('pizza')) return 'event';
    if (text.includes('payroll') || text.includes('salary')) return 'payroll';
    if (text.includes('transfer') || text.includes('loan') || text.includes('advance')) return 'transfer';
    return 'tuition';
  };
  const withinPeriod = (date, startDate, endDate) => {
    if (!date) return false;
    return (!startDate || date >= startDate) && (!endDate || date <= endDate);
  };
  const activeDate = (date, endDate) => !!date && (!endDate || date <= endDate);
  const createResult = (startDate, endDate) => ({
    startDate: startDate || null,
    endDate: endDate || null,
    movements: [],
    exceptions: [],
    totals: {
      collectionsCents: 0,
      expensesCents: 0,
      payrollCents: 0,
      cashInCents: 0,
      cashOutCents: 0,
      onlineInCents: 0,
      onlineOutCents: 0,
      unclassifiedInCents: 0,
      unclassifiedOutCents: 0,
      overpaymentsCents: 0,
      creditLiabilityCents: 0,
      zigExpenseCents: 0
    },
    accounts: {
      cash: { inflowCents: 0, outflowCents: 0 },
      ecocash: { inflowCents: 0, outflowCents: 0 },
      bank: { inflowCents: 0, outflowCents: 0 },
      zipit: { inflowCents: 0, outflowCents: 0 },
      innbucks: { inflowCents: 0, outflowCents: 0 },
      onemoney: { inflowCents: 0, outflowCents: 0 },
      card: { inflowCents: 0, outflowCents: 0 },
      online_other: { inflowCents: 0, outflowCents: 0 }
    }
  });

  function calculateVaultFinancials(input) {
    const source = input || {};
    const startDate = isoDate(source.startDate);
    const endDate = isoDate(source.endDate);
    if (startDate && endDate && startDate > endDate) {
      throw new Error('The report start date must be on or before its end date.');
    }
    const result = createResult(startDate, endDate);
    const ledgerRows = Array.isArray(source.ledger) ? source.ledger : [];
    const ledgerReceipts = new Set();
    const seen = new Set();
    const asOfDate = endDate || isoDate(source.today) || new Date().toISOString().slice(0, 10);

    const addException = (code, date, ref, description, amountCents) => {
      result.exceptions.push({
        code, date: date || 'Date not recorded', ref: String(ref || 'No reference'),
        description: String(description || code), amountCents: Math.abs(amountCents || 0)
      });
    };
    const addMovement = movement => {
      const identity = movement.source + ':' + movement.sourceId;
      if (seen.has(identity)) {
        addException('DUPLICATE_SOURCE', movement.date, movement.reference, 'The same source record was encountered more than once.', movement.amountCents);
        return;
      }
      seen.add(identity);
      result.movements.push(movement);
      const amount = Math.abs(movement.amountCents || 0);
      const direction = movement.direction;
      if (movement.kind === 'collection') {
        result.totals.collectionsCents += amount;
        if (movement.account === 'cash') {
          result.totals.cashInCents += amount;
          result.accounts.cash.inflowCents += amount;
        } else if (movement.account === 'unclassified') {
          result.totals.unclassifiedInCents += amount;
        } else if (movement.account && result.accounts[movement.account]) {
          result.totals.onlineInCents += amount;
          result.accounts[movement.account].inflowCents += amount;
        }
      } else if (movement.kind === 'expense' || movement.kind === 'payroll') {
        if (movement.kind === 'expense') result.totals.expensesCents += amount;
        if (movement.kind === 'payroll') result.totals.payrollCents += amount;
        if (movement.account === 'cash') {
          result.totals.cashOutCents += amount;
          result.accounts.cash.outflowCents += amount;
        } else if (movement.account === 'unclassified') {
          result.totals.unclassifiedOutCents += amount;
        } else if (movement.account && result.accounts[movement.account]) {
          result.totals.onlineOutCents += amount;
          result.accounts[movement.account].outflowCents += amount;
        }
      }
      if (movement.category === 'overpayment' && movement.kind === 'collection') {
        result.totals.overpaymentsCents += amount;
      }
    };

    // Student ledger is the authoritative source for student receipts and event collections.
    ledgerRows.forEach(row => {
      if (!row || !isValidStatus(row.status)) return;
      const type = String(row.type || '').trim().toLowerCase();
      const date = isoDate(row.date);
      const amountCents = Math.abs(cents(row.amount));
      const reference = row.receipt_no || row.receiptNo || row.id;
      if (reference && ['payment', 'overpayment'].includes(type)) ledgerReceipts.add(String(reference).toUpperCase());

      if (date && activeDate(date, asOfDate)) {
        const liabilityBreakdown = Array.isArray(row.breakdown) && row.breakdown.length
          ? row.breakdown
          : [{ amt: amountCents / 100, desc: row.description || '' }];
        if (type === 'overpayment') {
          result.totals.creditLiabilityCents += amountCents;
        } else if (type === 'payment') {
          const liabilityWeight = liabilityBreakdown.reduce((sum, line) => {
            const description = String(line.desc || line.description || row.description || '').toLowerCase();
            return sum + (description.includes('overpayment') || description.includes('account credit') || description.includes('advance credit')
              ? Math.max(0, cents(line.amt ?? line.amount)) : 0);
          }, 0);
          const allWeights = liabilityBreakdown.reduce((sum, line) => sum + Math.max(0, cents(line.amt ?? line.amount)), 0);
          if (liabilityWeight > 0) {
            result.totals.creditLiabilityCents += allWeights > 0
              ? Math.round(amountCents * liabilityWeight / allWeights)
              : liabilityWeight;
          }
        }
        const creditBacked = row.is_credit_backed === true || String(row.is_credit_backed).toLowerCase() === 'true' ||
          String(row.method || '').toLowerCase().includes('advance credit') ||
          String(row.description || '').toLowerCase().includes('paid via advance credit') || classifyMethod(row.method || row.payment_method) === 'credit';
        const creditUsed = Math.min(amountCents, Math.max(0, cents(row.credit_used)));
        if (creditBacked || creditUsed > 0) {
          result.totals.creditLiabilityCents -= creditUsed || (creditBacked ? amountCents : 0);
        }
      }

      if (!withinPeriod(date, startDate, endDate)) {
        if (!date && ['payment', 'overpayment'].includes(type)) addException('MISSING_LEDGER_DATE', '', reference, 'Student payment has no usable business date.', amountCents);
        return;
      }
      if (!['payment', 'overpayment'].includes(type)) {
        if (type === 'credit') addException('UNMAPPED_CREDIT_LEDGER', date, reference, 'A credit ledger entry needs a confirmed creation/application meaning.', amountCents);
        return;
      }
      if (amountCents <= 0) return;

      const methodLabel = row.method || row.payment_method || '';
      const account = classifyMethod(methodLabel);
      const creditBacked = row.is_credit_backed === true || String(row.is_credit_backed).toLowerCase() === 'true' ||
        String(methodLabel).toLowerCase().includes('advance credit') ||
        String(row.description || '').toLowerCase().includes('paid via advance credit');
      const creditUsed = Math.min(amountCents, Math.max(0, cents(row.credit_used)));
      const actualReceived = Math.max(0, amountCents - (creditUsed || (creditBacked ? amountCents : 0)));
      if (actualReceived <= 0) return;
      if (account === 'credit') return;
      if (account === 'unclassified') {
        addException('UNKNOWN_PAYMENT_METHOD', date, reference, 'Student payment method is missing or cannot be safely classified.', actualReceived);
      }
      const breakdown = Array.isArray(row.breakdown) && row.breakdown.length
        ? row.breakdown
        : [{ amt: amountCents / 100, desc: row.description || 'Student payment' }];
      const rawWeights = breakdown.map(line => Math.max(0, cents(line.amt ?? line.amount)));
      const weightTotal = rawWeights.reduce((sum, value) => sum + value, 0);
      let assigned = 0;
      breakdown.forEach((line, index) => {
        const allocation = index === breakdown.length - 1
          ? actualReceived - assigned
          : (weightTotal > 0 ? Math.round(actualReceived * rawWeights[index] / weightTotal) : Math.floor(actualReceived / breakdown.length));
        assigned += allocation;
        const description = line.desc || line.description || row.description || 'Student payment';
        const category = categoryFor(description, type);
        const lineMovement = {
          source: 'student_ledger', sourceId: String(row.id || reference || '') + ':' + index,
          date, reference: String(reference || 'No receipt'),
          description: String(description), studentId: String(row.student_id || ''),
          method: String(methodLabel || 'Not recorded'), account: account === 'credit' ? 'unclassified' : account,
          category, kind: 'collection', direction: 'in', amountCents: Math.max(0, allocation)
        };
        addMovement(lineMovement);
      });
    });

    // POS records are only added for walk-in sales; student POS receipts already exist in the student ledger.
    (Array.isArray(source.transactions) ? source.transactions : []).forEach(sale => {
      if (!sale || !isValidStatus(sale.status)) return;
      const studentId = String(sale.student_id || '').trim().toUpperCase();
      const isWalkIn = !studentId || studentId === 'WALK-IN';
      if (!isWalkIn) return;
      const date = isoDate(sale.date);
      const reference = sale.receipt_no || sale.id;
      if (!withinPeriod(date, startDate, endDate)) {
        if (!date) addException('MISSING_POS_DATE', '', reference, 'Walk-in sale has no usable business date.', cents(sale.usdpaid ?? sale.total ?? sale.amount));
        return;
      }
      if (reference && ledgerReceipts.has(String(reference).toUpperCase())) return;
      const methodLabel = sale.paymentmethod || sale.paymentMethod || sale.payment_method || sale.method || '';
      const account = classifyMethod(methodLabel);
      const paid = sale.usdpaid !== null && sale.usdpaid !== undefined
        ? Math.max(0, cents(sale.usdpaid))
        : Math.max(0, cents(sale.total ?? sale.amount));
      const creditApplied = Math.max(0, cents(sale.credit_applied_amount));
      const actualReceived = Math.max(0, paid);
      if (creditApplied > 0 || account === 'credit') {
        addException('POS_CREDIT_COMPONENT', date, reference, 'POS credit components are not new money received.', creditApplied || actualReceived);
      }
      if (actualReceived <= 0) return;
      if (account === 'unclassified') addException('UNKNOWN_POS_METHOD', date, reference, 'Walk-in POS payment method is missing or cannot be classified.', actualReceived);
      addMovement({
        source: 'transactions', sourceId: String(sale.id || reference || ''), date,
        reference: String(reference || 'No receipt'), description: String(sale.description || sale.item || 'Walk-in POS sale'),
        studentId: 'WALK-IN', method: String(methodLabel || 'Not recorded'),
        account: account === 'credit' ? 'unclassified' : account,
        category: 'shop', kind: 'collection', direction: 'in', amountCents: actualReceived
      });
    });

    // Expenses include stock purchases. A missing payment method is never silently assumed to be cash.
    (Array.isArray(source.expenses) ? source.expenses : []).forEach(expense => {
      if (!expense || !isValidStatus(expense.status)) return;
      const data = parseData(expense.data);
      const date = isoDate(expense.date || data.date);
      const reference = expense.id || data.id;
      const description = expense.description || data.description || data.desc || 'Expense';
      const amountCents = Math.abs(cents(expense.amount ?? data.amount ?? data.total));
      if (!withinPeriod(date, startDate, endDate)) {
        if (!date && amountCents > 0) addException('MISSING_EXPENSE_DATE', '', reference, 'Expense has no usable business date.', amountCents);
        return;
      }
      if (amountCents <= 0) return;
      const status = String(expense.status || data.status || 'ACTIVE').toUpperCase();
      if (!isPaidStatus(status)) {
        addException('EXPENSE_NOT_CONFIRMED_PAID', date, reference, 'Expense is not in a confirmed paid/active state and was not deducted from cash.', amountCents);
        return;
      }
      const type = String(expense.type || data.type || '').toLowerCase();
      if (type.includes('transfer') || type.includes('advance') || type.includes('loan')) {
        addException('TRANSFER_NEEDS_MATCHING_ENTRY', date, reference, 'Transfer/advance/loan requires paired account movements; it is not treated as an expense.', amountCents);
        return;
      }
      const currency = String(expense.currency || data.currency || 'USD').toUpperCase();
      const methodLabel = expense.payment_method || data.payment_method || expense.method || data.method || '';
      const account = classifyMethod(methodLabel);
      if (currency === 'ZIG' || currency === 'ZWG') {
        result.totals.zigExpenseCents += amountCents;
        return;
      }
      if (account === 'credit') {
        addException('SUPPLIER_CREDIT_NOT_PAID', date, reference, 'Supplier-credit purchase is not a cash outflow until paid.', amountCents);
        return;
      }
      if (account === 'unclassified') addException('UNKNOWN_EXPENSE_METHOD', date, reference, 'Expense has no reliable payment method; it is not assigned to a cash/bank account.', amountCents);
      addMovement({
        source: 'expenses', sourceId: String(reference || ''), date,
        reference: String(reference || 'No reference'), description: String(description),
        method: String(methodLabel || 'Not recorded'), account,
        category: 'expense', kind: 'expense', direction: 'out', amountCents
      });
    });

    // Only completed payroll disbursements are financial outflows.
    (Array.isArray(source.payroll) ? source.payroll : []).forEach(payroll => {
      if (!payroll || !isValidStatus(payroll.status)) return;
      const date = isoDate(payroll.payment_date || payroll.date);
      const reference = payroll.reference_number || payroll.id;
      const amountCents = Math.abs(cents(payroll.amount));
      if (!withinPeriod(date, startDate, endDate)) {
        if (!date && amountCents > 0) addException('MISSING_PAYROLL_DATE', '', reference, 'Payroll has no usable payment date.', amountCents);
        return;
      }
      if (amountCents <= 0) return;
      if (!isPaidStatus(payroll.status)) {
        addException('PAYROLL_NOT_CONFIRMED_PAID', date, reference, 'Payroll status is not confirmed as paid; it was not deducted from an account.', amountCents);
        return;
      }
      const methodLabel = payroll.payment_method || '';
      const account = classifyMethod(methodLabel);
      if (account === 'credit') {
        addException('PAYROLL_CREDIT_METHOD', date, reference, 'Payroll cannot be treated as a student-credit movement.', amountCents);
        return;
      }
      if (account === 'unclassified') addException('UNKNOWN_PAYROLL_METHOD', date, reference, 'Payroll payment method is missing or cannot be classified.', amountCents);
      addMovement({
        source: 'payroll_history', sourceId: String(payroll.id || reference || ''), date,
        reference: String(reference || 'No reference'),
        description: String(payroll.notes || payroll.expenses || 'Payroll payment'),
        method: String(methodLabel || 'Not recorded'), account,
        category: 'payroll', kind: 'payroll', direction: 'out', amountCents
      });
    });

    if (result.totals.creditLiabilityCents < 0) {
      addException('NEGATIVE_STUDENT_CREDIT', asOfDate, '', 'Credit applications exceed recorded overpayments; investigate historical credit records.', Math.abs(result.totals.creditLiabilityCents));
      result.totals.creditLiabilityCents = 0;
    }
    result.movements.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.sourceId.localeCompare(b.sourceId));
    result.totals.netCashCents = result.totals.cashInCents - result.totals.cashOutCents;
    result.totals.netOnlineCents = result.totals.onlineInCents - result.totals.onlineOutCents;
    result.totals.netMovementCents = result.totals.collectionsCents - result.totals.expensesCents - result.totals.payrollCents;
    result.totals.isComplete = result.exceptions.length === 0;
    return result;
  }

  return {
    cents, money, isoDate, classifyMethod, categoryFor, calculateVaultFinancials
  };
});