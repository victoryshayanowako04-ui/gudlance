# Gudlance Netlify Release Checklist

This checklist applies to the merged `main` branch. The secure Vault integration is now on main.

## Netlify site settings

- Deploy branch: `main`
- Build command: leave blank (the application is static)
- Publish directory: `.`
- Functions directory: `netlify/functions` (configured in `netlify.toml`)

## Netlify environment variables

Set these in the Netlify site environment. Never put service keys in frontend files or commit them.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side secret used by the Chief Admin verification function)
- `RESEND_API_KEY`
- `MFA_FROM_EMAIL`
- `PAYNOW_ID`
- `PAYNOW_KEY`

The public Supabase URL and publishable key already used by the browser are not substitutes for the server-side service-role secret.

## Vault origin allowlist

The Supabase Edge Function `vault-session` is active at version 7. It allows:
- `https://gudlance.pages.dev` and its project preview subdomains
- The exact Netlify production origin `https://gudlance.netlify.app`

The exact Netlify origin is committed in `supabase/functions/vault-session/index.ts` and deployed to Supabase. No additional Vault-origin secret is required for `gudlance.netlify.app`. If a different custom domain is used, add its exact HTTPS origin to the function source and redeploy the function. Do not use a wildcard.

## Important checks before production use

- The four Vault migrations are already present in the live Supabase migration history. Do not apply them again blindly.
- The Vault opens and closes real daily sessions. Do not test opening floats, cash counts, or financial movements against production data.
- `netlify/functions/pay.js` currently points Paynow result notifications to `/.netlify/functions/receipt`, but `netlify/functions/receipt.js` does not exist. Paynow confirmation is not production-ready until a verified, idempotent callback is implemented and tested.
- Confirm email delivery, Paynow callbacks, sign-in, enrolment, payments, events, trips, WhatsApp and Shop in a non-production test environment before switching users.
- Never paste Supabase service-role keys, Paynow keys or Resend API keys into chat or frontend code.

## Current release status

- Vault integration merged into `main` in commit `ffdf6411f2df41273183052a123d12f2f938da0c`.
- Netlify Vault CORS support deployed as `vault-session` version 7 and synchronized to the repository in commit `5b86ec8c4b289268037f2023774878516291bb35`.
- Cloudflare Pages deployment of the Vault merge succeeded.
- The GitHub Actions regression job still exits before any steps start because no runner is allocated. The focused Vault suite previously passed 48 tests in an isolated harness, but hosted CI has not passed.
- This is the correct source branch for a Netlify test deployment. Do not switch production traffic until the Paynow callback and the full logged-in application workflows have been verified.
