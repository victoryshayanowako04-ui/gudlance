const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateVaultFinancials, cents, classifyMethod } = require('../js/vault-financial-core');

test('money is rounded to cents and payment methods are classified conservatively', () => {
  assert.equal(cents(1.005), 101);
  assert.equal(classifyMethod('Cash USD'), 'cash');
  assert.equal(classifyMethod('EcoCash (CD)'), 'ecocash');
  assert.equal(classifyMethod('Bank Transfer'), 'bank');
  assert.equal(classifyMethod('Advance Credit'), 'credit');
  assert.equal(classifyMethod(''), 'unclassified');
  assert.equal(classifyMethod('Cash + EcoCash'), 'unclassified');
});

test('mixed payment breakdown counts the receipt once and allocates overpayment correctly', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    ledger: [{
      id: 'L1', student_id: 'STU-1', date: '2026-11-24', type: 'payment',
      amount: 30, method: 'Cash', status: 'ACTIVE', receipt_no: 'R1',
      breakdown: [{ amt: 20, desc: 'Tuition fee' }, { amt: 10, desc: 'Account Overpayment' }]
    }]
  });
  assert.equal(result.totals.collectionsCents, 3000);
  assert.equal(result.totals.cashInCents, 3000);
  assert.equal(result.totals.overpaymentsCents, 1000);
  assert.equal(result.movements.length, 2);
  assert.equal(result.totals.creditLiabilityCents, 1000);
});

test('credit-funded payments are not counted as new money and reduce outstanding credit', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-25',
    ledger: [
      { id: 'O1', student_id: 'STU-1', date: '2026-11-24', type: 'overpayment', amount: 50, method: 'Cash', status: 'ACTIVE', receipt_no: 'R1' },
      { id: 'C1', student_id: 'STU-1', date: '2026-11-25', type: 'payment', amount: 20, method: 'Advance Credit', is_credit_backed: true, status: 'ACTIVE', receipt_no: 'R2' }
    ]
  });
  assert.equal(result.totals.collectionsCents, 5000);
  assert.equal(result.totals.cashInCents, 5000);
  assert.equal(result.totals.creditLiabilityCents, 3000);
});

test('cash stock purchases and reconciled walk-in POS sales remain in cash movement', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    ledger: [],
    transactions: [{
      id: 'POS1', student_id: 'WALK-IN', date: '2026-11-24', status: 'ACTIVE',
      reconciled: true, receipt_no: 'POS-R1', paymentmethod: 'Cash USD',
      total: 16, usdpaid: 16, amount: 16
    }],
    expenses: [{
      id: 'EXP-INV-1', status: 'ACTIVE', data: {
        date: '2026-11-24', amount: 320, payment_method: 'Cash',
        description: 'Stock Purchase: uniforms'
      }
    }]
  });
  assert.equal(result.totals.cashInCents, 1600);
  assert.equal(result.totals.cashOutCents, 32000);
  assert.equal(result.totals.netCashCents, -30400);
  assert.equal(result.movements.length, 2);
});

test('a walk-in POS receipt already represented in the ledger is not counted twice', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    ledger: [{
      id: 'L1', student_id: 'WALK-IN', date: '2026-11-24', type: 'payment',
      amount: 16, method: 'Cash', status: 'ACTIVE', receipt_no: 'SAME'
    }],
    transactions: [{
      id: 'POS1', student_id: 'WALK-IN', date: '2026-11-24', status: 'ACTIVE',
      receipt_no: 'SAME', paymentmethod: 'Cash USD', total: 16, usdpaid: 16
    }]
  });
  assert.equal(result.totals.collectionsCents, 1600);
  assert.equal(result.movements.length, 1);
});

test('date boundaries are inclusive and liability is an as-of-end-date snapshot', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-25', endDate: '2026-11-25',
    ledger: [
      { id: 'O1', student_id: 'STU-1', date: '2026-11-24', type: 'overpayment', amount: 40, method: 'Cash', status: 'ACTIVE', receipt_no: 'R1' },
      { id: 'P1', student_id: 'STU-1', date: '2026-11-25', type: 'payment', amount: 10, method: 'Advance Credit', is_credit_backed: true, status: 'ACTIVE', receipt_no: 'R2' },
      { id: 'O2', student_id: 'STU-1', date: '2026-11-26', type: 'overpayment', amount: 90, method: 'Cash', status: 'ACTIVE', receipt_no: 'R3' }
    ]
  });
  assert.equal(result.totals.collectionsCents, 0);
  assert.equal(result.totals.creditLiabilityCents, 3000);
});

test('unknown expense payment method is not silently treated as cash', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    expenses: [{ id: 'E1', date: '2026-11-24', amount: 25, status: 'ACTIVE', description: 'Office supplies' }]
  });
  assert.equal(result.totals.cashOutCents, 0);
  assert.equal(result.totals.unclassifiedOutCents, 2500);
  assert.ok(result.exceptions.some(exception => exception.code === 'UNKNOWN_EXPENSE_METHOD'));
});

test('payroll is deducted from the actual payment channel and not counted as cash by default', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    payroll: [{ id: 'PAY1', payment_date: '2026-11-24', amount: 100, payment_method: 'Bank Transfer', status: 'Paid' }]
  });
  assert.equal(result.totals.payrollCents, 10000);
  assert.equal(result.totals.cashOutCents, 0);
  assert.equal(result.totals.onlineOutCents, 10000);
  assert.equal(result.totals.netOnlineCents, -10000);
});

test('unpaid payroll is not deducted from any account', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    payroll: [{ id: 'PAY1', payment_date: '2026-11-24', amount: 100, payment_method: 'Cash', status: 'Pending' }]
  });
  assert.equal(result.totals.cashOutCents, 0);
  assert.ok(result.exceptions.some(exception => exception.code === 'PAYROLL_NOT_CONFIRMED_PAID'));
});


test('24 November 2026 reconciles cash and EcoCash independently', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    ledger: [
      { id: 'CASH-NORMAL', date: '2026-11-24', type: 'payment', amount: 708, method: 'Cash', status: 'ACTIVE', receipt_no: 'C1' },
      { id: 'CASH-OVER', date: '2026-11-24', type: 'overpayment', amount: 50, method: 'Cash', status: 'ACTIVE', receipt_no: 'C2' },
      { id: 'ECO-NORMAL', date: '2026-11-24', type: 'payment', amount: 138, method: 'EcoCash', status: 'ACTIVE', receipt_no: 'E1' },
      { id: 'ECO-OVER', date: '2026-11-24', type: 'overpayment', amount: 85, method: 'EcoCash', status: 'ACTIVE', receipt_no: 'E2' }
    ],
    expenses: [
      { id: 'CASH-EXP', date: '2026-11-24', amount: 605, payment_method: 'Cash', status: 'ACTIVE' },
      { id: 'ECO-EXP', date: '2026-11-24', amount: 610, payment_method: 'EcoCash', status: 'ACTIVE' }
    ]
  });
  assert.equal(result.totals.collectionsCents, 98100);
  assert.equal(result.totals.cashInCents, 75800);
  assert.equal(result.totals.onlineInCents, 22300);
  assert.equal(result.totals.expensesCents, 121500);
  assert.equal(result.totals.cashOutCents, 60500);
  assert.equal(result.totals.onlineOutCents, 61000);
  assert.equal(result.totals.netCashCents, 15300);
  assert.equal(result.totals.netOnlineCents, -38700);
  assert.equal(result.totals.overpaymentsCents, 13500);
  assert.equal(result.exceptions.length, 0);
});


test('paid payment rows missing from the ledger are included once and flagged for review', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    ledger: [],
    payments: [{
      id: 901, student_id: 'STU-9', date: '2026-11-24', receipt_no: 'MISSING-LEDGER-1',
      amount: 25, method: 'Cash', status: 'PAID', category: 'Tuition'
    }]
  });
  assert.equal(result.totals.collectionsCents, 2500);
  assert.equal(result.totals.cashInCents, 2500);
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0].source, 'payments');
  assert.ok(result.exceptions.some(item => item.code === 'PAYMENT_MISSING_LEDGER'));
});

test('payment fallback does not duplicate a receipt already represented for the same student', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    ledger: [{
      id: 'L1', student_id: 'STU-9', date: '2026-11-24', type: 'payment',
      amount: 25, method: 'Cash', status: 'ACTIVE', receipt_no: 'MATCHED-1'
    }],
    payments: [{
      id: 901, student_id: 'STU-9', date: '2026-11-24', receipt_no: 'MATCHED-1',
      amount: 25, method: 'Cash', status: 'PAID', category: 'Tuition'
    }]
  });
  assert.equal(result.totals.collectionsCents, 2500);
  assert.equal(result.movements.length, 1);
  assert.equal(result.exceptions.length, 0);
});

test('a fallback overpayment is included in collections and outstanding student credit', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    ledger: [],
    payments: [{
      id: 902, student_id: 'STU-10', date: '2026-11-24', receipt_no: 'MISSING-OVERPAY-1',
      amount: 12, method: 'EcoCash', status: 'PAID', category: 'Overpayment'
    }]
  });
  assert.equal(result.totals.collectionsCents, 1200);
  assert.equal(result.totals.onlineInCents, 1200);
  assert.equal(result.totals.overpaymentsCents, 1200);
  assert.equal(result.totals.creditLiabilityCents, 1200);
});


test('walk-in payment fallback is not duplicated when the same receipt exists in POS', () => {
  const result = calculateVaultFinancials({
    startDate: '2026-11-24', endDate: '2026-11-24',
    ledger: [],
    payments: [{
      id: 903, student_id: null, date: '2026-11-24', receipt_no: 'WALKIN-1',
      amount: 16, method: 'Cash USD', status: 'PAID', category: 'Shop'
    }],
    transactions: [{
      id: 'POS-903', student_id: 'WALK-IN', date: '2026-11-24', status: 'ACTIVE',
      receipt_no: 'WALKIN-1', paymentmethod: 'Cash USD', total: 16, usdpaid: 16
    }]
  });
  assert.equal(result.totals.collectionsCents, 1600);
  assert.equal(result.totals.cashInCents, 1600);
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0].source, 'transactions');
  assert.equal(result.exceptions.length, 0);
});
