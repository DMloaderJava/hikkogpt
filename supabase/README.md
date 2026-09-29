# Supabase operations and migration status

Updated: 2026-09-29

## Projects and cutover status

- **New destination:** `hikkogpt-v2`, project ref `cicxhufrnqiciczeptlu`, region `us-east-1`, API URL `https://cicxhufrnqiciczeptlu.supabase.co`.
- **Current source:** `islgkqdsztchzajnulof`.
- **Production site:** `https://hikkogpt.vercel.app`.
- Production/Vercel still points to the source project. Do **not** switch Vercel until Auth, secrets, Storage objects, and user-linked records are finished and checked.
- The new project's public publishable key is in the ignored local `.env`; never commit `.env`, service-role keys, database passwords, JWT secrets, or provider credentials.

## Destination schema and migrations

These migrations are applied on the destination and the filenames match its migration history:

1. `20260928175002_reconstructed_source_schema.sql` — reconstructed app schema, RLS, constraints, indexes, RPCs, and Storage policies.
2. `20260928175110_create_chat_tables_with_rls.sql` — owner-scoped `chats` and `messages` tables.
3. `20260928175312_auth_security_hardening.sql` — fixed search paths, least-privilege RPC grants, owner/admin checks, and explicit chat Data API grants.
4. `20260929180000_disable_email_confirmation_permanently.sql` — email confirmation off for good (idempotent; run it in the Dashboard SQL Editor, or via `supabase db push`): confirms all existing `auth.users`, auto-confirms new ones via a trigger, keeps the service-role-only `confirm_auth_email` fallback for `auth-register`, and drops the unused login-guard objects (`login_challenges` + its RPCs).

All destination public tables have RLS enabled. The Security Advisor reports no anonymous `EXECUTE` access to `SECURITY DEFINER` functions. After migration 4 its only remaining authenticated-only warning is the intentional self/admin-scoped RPC `has_role`.

## Data currently transferred

The public catalog was copied and destination counts verified:

- 2 titles; 0 genres; 0 title/genre links.
- 2 chapters; 47 pages; 0 chapter voiceovers.
- 1 ad.
- Page `original_url` values were intentionally not copied; some can be private or expiring links. Public image/cover/audio URLs still reference the source Storage project until the objects are copied and URLs rewritten.

The destination has the five bucket definitions (`hikko-originals` private; `manga`, `submissions`, `title-covers`, and `voiceovers` public). **Storage objects are not copied yet.** The source currently has 98 objects: 48 in private `hikko-originals`, 49 in `manga`, and 1 in `title-covers`.

Auth users, user roles, admin requests, per-user encrypted API keys, and rate-limit history have not been copied. The source inventory had 4 Auth users (2 confirmed, 2 unconfirmed). Rate limits are ephemeral and should start fresh. When migrating users, their password hashes can be preserved; because the destination has a different JWT secret, users must sign in again. Email confirmation is off for good: migration `20260929180000_disable_email_confirmation_permanently.sql` confirms unconfirmed accounts and drops the login-challenge table, so no account ever needs a mail link.

## Auth settings still to configure

Email confirmation is off for good. The app only signs in/registers by email + password: signup goes through the `auth-register` Edge Function (creates an already-confirmed user, no email), login is `signInWithPassword`, and the admin login guard (challenge confirmed by an email link) is removed. Login never tells the user to check their inbox.

Two remaining steps on the destination, neither can be done from this repo:

1. Run `20260929180000_disable_email_confirmation_permanently.sql` in **Dashboard → SQL Editor** (idempotent). It confirms all existing `auth.users`, installs the auto-confirm trigger for new users, and drops the login-guard table/RPCs.
2. Turn **Confirm email** off in **Authentication → Sign In / Up → Providers → Email** (the hosted GoTrue flag is separate from the database; the destination previously reported `mailer_autoconfirm=false`, i.e. a direct public `signUp` would still mail a link). Or `PATCH /v1/projects/<ref>/config/auth` with `{ "mailer_autoconfirm": true }`. The `auth-register` path does not need this flag, but with it off no client can mail a confirmation link at all.

Also, if the old Edge Functions are still deployed on the destination, delete them: `supabase functions delete login-notify` and `supabase functions delete login-confirm` (they are removed from this repo; the app no longer calls them).

Remaining Auth URL hygiene:

1. Open **Authentication → URL Configuration**. Set Site URL to `https://hikkogpt.vercel.app`; allow the production URL, `https://hikkogpt.vercel.app/auth?mode=reset`, the project's Vercel preview URLs, and local dev URLs (`http://localhost:5173/**`, `http://127.0.0.1:5173/**`).
2. Consider enabling leaked-password protection if available. Any email flow that stays enabled (e.g. password recovery, if kept on) should use a custom SMTP provider if the built-in service's rate limit is insufficient. Never put SMTP credentials in this repository.

## Edge Functions

Local Edge Functions follow the gateway JWT settings in `config.toml`. `auth-register` is the no-email signup path (`verify_jwt = false`; it confirms the user with the service role and does not return a session). The client does not call public `signUp`, because that sends a confirmation link while Confirm email is on. Deploy the function (`supabase functions deploy auth-register`) and apply `20260929180000_disable_email_confirmation_permanently.sql`, or signup cannot skip the letter. Do not change `verify_jwt` without reviewing the handler's auth path. `submit-title` and `get-submission` intentionally use custom CAPTCHA/rate-limit controls; `gemini-proxy` validates the caller JWT and admin role in the handler. `notify-submitter` is kept for admin-client compatibility and always completes without sending an email.

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` into the Edge runtime. The following app-specific names may need values configured in **Project Settings → Edge Functions → Secrets**; only configure the providers/features the app uses:

- Submission protection: `RATE_LIMIT_SALT`, `CAPTCHA_PROVIDER`, and either `TURNSTILE_SECRET_KEY` or `HCAPTCHA_SECRET_KEY`.
- Encrypted per-user API keys: `USER_KEY_ENC_SECRET`. To keep existing ciphertext readable, use the exact same value as the source project; never generate a replacement unless the stored keys are re-encrypted first.
- AI/provider features: `GEMINI_API_KEYS`, `GEMINI_CHAT_MODEL`, `GEMINI_ANALYST_MODEL`, `GEMINI_LIVE_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_VISION_MODEL`, `FIRECRAWL_API_KEY`, `ELEVENLABS_API_KEY`, and `LOVABLE_API_KEY`.

Do not paste secret values in chat, SQL, GitHub, or frontend `VITE_*` variables. Use the Supabase Dashboard's secret editor or a secure local secret manager.

## Remaining cutover checklist

- [x] Disable email confirmations for good in the app: `auth-register` creates confirmed users, the login guard is removed, login is plain email + password (no mail anywhere).
- [ ] Run `20260929180000_disable_email_confirmation_permanently.sql` in the destination **SQL Editor**, then turn **Confirm email** off in the destination Dashboard (and set the Auth URL allowlist).
- [ ] Delete the stale deployed functions if present: `supabase functions delete login-notify`, `supabase functions delete login-confirm`.
- [ ] Decide/authorize whether to migrate Auth users with password hashes and admin-role records. Unconfirmed accounts are confirmed by the migration above (mail-link verification is off).
- [ ] Configure required Edge Function secrets in the destination.
- [ ] Copy the 98 Storage objects; preserve private bucket visibility; then rewrite public database URLs to the destination.
- [ ] Transfer remaining admin/user-linked records after users exist in the destination.
- [ ] Run Auth, RLS, Storage, and Edge Function smoke tests.
- [ ] Update Vercel's `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`, then deploy and verify production. Keep the source project intact until the cutover is confirmed.
