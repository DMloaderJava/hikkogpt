# Supabase operations and migration status

Updated: 2026-09-28

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

All destination public tables have RLS enabled. The Security Advisor reports no anonymous `EXECUTE` access to `SECURITY DEFINER` functions. Its remaining three authenticated-only warnings are the intentional self/admin-scoped RPCs `has_role`, `create_login_challenge`, and `latest_login_challenge_status`.

## Data currently transferred

The public catalog was copied and destination counts verified:

- 2 titles; 0 genres; 0 title/genre links.
- 2 chapters; 47 pages; 0 chapter voiceovers.
- 1 ad.
- Page `original_url` values were intentionally not copied; some can be private or expiring links. Public image/cover/audio URLs still reference the source Storage project until the objects are copied and URLs rewritten.

The destination has the five bucket definitions (`hikko-originals` private; `manga`, `submissions`, `title-covers`, and `voiceovers` public). **Storage objects are not copied yet.** The source currently has 98 objects: 48 in private `hikko-originals`, 49 in `manga`, and 1 in `title-covers`.

Auth users, user roles, admin requests, per-user encrypted API keys, login challenges, and rate-limit history have not been copied. The source inventory had 4 Auth users (2 confirmed, 2 unconfirmed). Login challenges/rate limits are ephemeral and should start fresh. When migrating users, their password hashes can be preserved; because the destination has a different JWT secret, users must sign in again. Preserve their confirmation status unless the owner explicitly chooses otherwise.

## Auth settings still to configure

For this hosted project, email confirmation is a Dashboard Auth-provider setting, **not a SQL migration**. The destination currently reports `mailer_autoconfirm=false` (confirmation still enabled).

1. Open **Authentication → Sign In / Providers → Email** and turn **Confirm email** off, then save.
2. Open **Authentication → URL Configuration**. Set Site URL to `https://hikkogpt.vercel.app`; allow the production URL, `https://hikkogpt.vercel.app/auth?mode=reset`, the project's Vercel preview URLs, and local dev URLs (`http://localhost:5173/**`, `http://127.0.0.1:5173/**`).
3. Consider enabling leaked-password protection if available. For production email flows, configure a custom SMTP provider if the built-in service's rate limit is insufficient. Never put SMTP credentials in this repository.

## Edge Functions

All 15 local Edge Functions are active on the destination with the same gateway JWT settings as the source. Do not change `verify_jwt` without reviewing the handler's auth path. `submit-title`, `get-submission`, and `login-confirm` intentionally use custom CAPTCHA/rate-limit/one-time-token controls; `gemini-proxy` validates the caller JWT and admin role in the handler.

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` into the Edge runtime. The following app-specific names may need values configured in **Project Settings → Edge Functions → Secrets**; only configure the providers/features the app uses:

- Submission protection: `RATE_LIMIT_SALT`, `CAPTCHA_PROVIDER`, and either `TURNSTILE_SECRET_KEY` or `HCAPTCHA_SECRET_KEY`.
- Encrypted per-user API keys: `USER_KEY_ENC_SECRET`. To keep existing ciphertext readable, use the exact same value as the source project; never generate a replacement unless the stored keys are re-encrypted first.
- AI/provider features: `GEMINI_API_KEYS`, `GEMINI_CHAT_MODEL`, `GEMINI_ANALYST_MODEL`, `GEMINI_LIVE_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_VISION_MODEL`, `FIRECRAWL_API_KEY`, `ELEVENLABS_API_KEY`, and `LOVABLE_API_KEY`.
- Login notifications: `RESEND_API_KEY`, `OWNER_NOTIFY_EMAIL`, and `OWNER_NOTIFY_FROM`.

Do not paste secret values in chat, SQL, GitHub, or frontend `VITE_*` variables. Use the Supabase Dashboard's secret editor or a secure local secret manager.

## Remaining cutover checklist

- [ ] Disable email confirmation and set Auth URL allowlist in the destination Dashboard.
- [ ] Decide/authorize whether to migrate Auth users with password hashes and admin-role records; keep unconfirmed accounts unconfirmed unless explicitly approved.
- [ ] Configure required Edge Function secrets in the destination.
- [ ] Copy the 98 Storage objects; preserve private bucket visibility; then rewrite public database URLs to the destination.
- [ ] Transfer remaining admin/user-linked records after users exist in the destination.
- [ ] Run Auth, RLS, Storage, and Edge Function smoke tests.
- [ ] Update Vercel's `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`, then deploy and verify production. Keep the source project intact until the cutover is confirmed.
