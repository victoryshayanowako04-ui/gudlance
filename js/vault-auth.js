(function () {
  'use strict';

  // Keep the unlock action single-flight. A double click or repeated event
  // cannot open multiple prompts or launch concurrent authentication requests.
  let unlockPromise = null;

  window.unlockAdminFinance = async function () {
    if (unlockPromise) return unlockPromise;

    const user = window.currentUser;
    const role = String(user?.role || '').trim().toLowerCase();
    const isChiefAdmin = role.includes('level 3') || role === 'chief admin';
    if (!isChiefAdmin) {
      alert('Access denied. Only Chief Admins can view the Vault.');
      return;
    }

    const unlockButton = document.getElementById('unlockBtn');
    const statsPanel = document.getElementById('adminFinanceStats');
    if (!unlockButton || !statsPanel) {
      console.error('[Gudlance Vault] Unlock controls are missing from the page.');
      return;
    }

    if (statsPanel.style.display !== 'none' && window.isVaultSessionAuthenticated?.()) {
      return;
    }

    unlockPromise = (async function () {
      const password = window.prompt('Enter your Vault password to continue.');
      if (!password) return;

      if (typeof window.setVaultSessionPassword !== 'function' ||
          typeof window.verifyVaultSession !== 'function') {
        alert('The secure Vault service has not finished loading. Refresh the page and try again.');
        return;
      }

      const originalLabel = unlockButton.textContent;
      unlockButton.disabled = true;
      unlockButton.textContent = 'Verifying access…';
      unlockButton.setAttribute('aria-busy', 'true');

      try {
        // The password is never compared with a users-table value in the browser.
        // The existing Edge Function verifies the Chief Admin and applies throttling.
        window.setVaultSessionPassword(password);

        const now = new Date();
        const today = [
          now.getFullYear(),
          String(now.getMonth() + 1).padStart(2, '0'),
          String(now.getDate()).padStart(2, '0')
        ].join('-');

        await window.verifyVaultSession(today);

        document.getElementById('vaultStartDate').value = today;
        document.getElementById('vaultEndDate').value = today;
        statsPanel.style.display = 'block';
        unlockButton.style.display = 'none';

        // One initial calculation. Subsequent refreshes are coalesced by the
        // financial engine instead of launching parallel legacy table scans.
        if (typeof window.calculateVaultStats === 'function') {
          await window.calculateVaultStats();
        } else {
          const message = document.getElementById('vaultControlMessage');
          if (message) message.textContent = 'Vault access verified, but the financial calculator did not load.';
        }
      } catch (error) {
        if (typeof window.clearVaultSessionPassword === 'function') {
          window.clearVaultSessionPassword();
        }
        console.error('[Gudlance Vault] Secure unlock failed:', error);
        const message = String(error?.message || '');
        const accessMessage = /429|too many|rate limit/i.test(message)
          ? 'Vault access is temporarily limited after repeated attempts. Wait for the security lock to expire before trying again.'
          : 'Vault access could not be verified. Check the password and your internet connection, then try once more.';
        alert(accessMessage);
      } finally {
        unlockButton.disabled = false;
        unlockButton.removeAttribute('aria-busy');
        unlockButton.textContent = originalLabel || '🔒 Unlock Vault';
      }
    })();

    try {
      return await unlockPromise;
    } finally {
      unlockPromise = null;
    }
  };
})();