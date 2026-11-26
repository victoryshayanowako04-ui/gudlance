# Gudlance Netlify Release Checklist

This is a deployment candidate based on the current `main` branch. It is kept separate so the existing live application is not changed while the Vault release is validated.

## Netlify site settings

- Deploy branch: `netlify-vault-release`
- Build command: leave blank (the application is static)
- Publish directory: `.`
- Functions directory: `netlify/functions` (already set in `netlify.toml`)

## Netlify environment variables

Set these in the Netlify site environment. Never put service keys in frontend files or commit them.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side secret, required by the Chief Admin verification function)
- `RESEND_API_KEY`
- `MFA_FROM_EMAIL`
- `PAYNOW_ID`
- `PAYNOW_KEY`

The public Supabase URL and publishable key already used by the browser are not substitutes for the server-side service-role secret.

## Vault origin allowlist

The Vault Edge Function keeps the existing Gudlance Cloudflare Pages origins and accepts additional HTTPS origins only when explicitly configured.

For this site, the exact production origin is `https://gudlance.netlify.app`. Set the Supabase Edge Function secret in the Supabase project dashboard (Edge Functions → Secrets):

`GUDLANCE_VAULT_ALLOWED_ORIGINS=https://gudlance.netlify.app`

Use the actual Netlify production origin, with no path and no wildcard. If a custom domain is used, include its exact HTTPS origin. Then deploy the updated `vault-session` Edge Function so the allowlist change takes effect.

## Important checks before production use

- Keep `main` unchanged until this release candidate passes regression tests and a live preview review.
- The Vault opens and closes real daily sessions. Do not test opening floats, cash counts, or financial movements against production data.
- The Vault migration files are included for source control. Check the Supabase migration history before applying anything again; do not blindly re-run already-applied migrations.
- The current `netlify/functions/pay.js` points Paynow result notifications to `/.netlify/functions/receipt`, but there is no `netlify/functions/receipt.js` in the repository at this revision. Paynow payment confirmation is therefore not production-ready until that callback is implemented and tested.
- Confirm email delivery, Paynow callbacks, Vault CORS, sign-in, enrolment, payments, events, trips, WhatsApp, and Shop in a non-production test environment before switching users.
- Never paste Supabase service-role keys, Paynow keys, or Resend API keys into chat or frontend code.

## Current release status

This branch is a validation candidate, not a production deployment. The GitHub Actions job currently fails before exposing any job steps or logs, so a passing CI result has not yet been established. Do not merge or switch the live site until that is resolved.
