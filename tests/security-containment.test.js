const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('client bundle no longer contains the hard-coded developer login or override', () => {
  for (const marker of ['isGodModeAttempt', 'DEV_MASTER_PASSWORD', 'DEV_001', 'Jayden', 'HuggoDev', 'System Creator']) {
    assert.equal(source.includes(marker), false, 'unexpected developer bypass marker: ' + marker);
  }
});

test('special God role is not normalized into an administrator role', () => {
  const start = source.indexOf('window.getNormalizedRole = function(rawRole) {');
  const end = source.indexOf('window.applyUserRole = function(role) {', start);
  assert.ok(start >= 0 && end > start);
  const context = { window: {} };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.window.getNormalizedRole('Level 3'), 'Level 3');
  assert.equal(context.window.getNormalizedRole('Level 2'), 'Level 2');
  assert.equal(context.window.getNormalizedRole('God Mode'), 'Unknown');
  assert.equal(context.window.canAccessRoleFeature('dashboard', 'Level 1'), true);
  assert.equal(context.window.canAccessRoleFeature('vault', 'Level 2'), false);
  assert.equal(context.window.canAccessRoleFeature('vault', 'Unknown'), false);
});

test('factory reset cannot issue client-side deletes', () => {
  const start = source.indexOf('window.factoryResetSystem = async function() {');
  const end = source.indexOf('\n};', start) + 3;
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.equal(block.includes('.delete('), false);
  assert.equal(block.includes('localStorage.removeItem'), false);
  let message = '';
  const context = { window: {}, alert: value => { message = value; } };
  vm.runInNewContext(block, context);
  context.window.factoryResetSystem();
  assert.match(message, /temporarily unavailable/i);
  assert.match(message, /No data has been changed/i);
});

test('maintenance mode is restricted to a real Level 3 role in the UI flow', () => {
  const start = source.indexOf('window.toggleSystemUpgrade = async function(isUpgrading) {');
  const end = source.indexOf('\n};', start) + 3;
  assert.ok(start >= 0 && end > start);
  let message = '';
  const context = {
    window: {
      currentUser: { role: 'Level 2' },
      getNormalizedRole: role => role
    },
    alert: value => { message = value; }
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.window.toggleSystemUpgrade(true);
  assert.match(message, /Chief Admin/i);
});

test('normal account login path remains present', () => {
  assert.match(source, /window\.attemptLogin = async function\(\)/);
  assert.match(source, /const foundUser = cloudUsers\.find/);
  assert.match(source, /window\.initializeApp\(\)/);
});
