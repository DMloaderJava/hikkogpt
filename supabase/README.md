# Supabase operations and migration status

Updated: 2026-09-29

## Projects and cutover status

- **Destination:** `hikkogpt-v2`, project ref `cicxhufrnqiciczeptlu`, region `us-east-1`, API URL `https://cicxhufrnqiciczeptlu.supabase.co`.
- **Source:** `islgkqdsztchzajnulof`.
- **Production site:** `https://hikkogpt.vercel.app`.
- The app's ignored local `.env` points to the destination. The last verified production state was still on the source project; no Vercel environment variable or deployment was changed during this continuation.
- Vercel project `hikkogpt` is visible, but listing its variables/deployments returned **403 Not authorized** for team scope `dmloaderjavas-projects`. Do not attempt to bypass this scope restriction. Reauthorize the Vercel connector for the correct team scope before cutover.
- Never commit `.env`, service-role keys, database passwords, JWT secrets, or provider credentials.

## Destination schema and security

These migrations are applied on the destination and match its migration history:

1. `20260928175002_reconstructed_source_schema.sql` — reconstructed app schema, RLS, constraints, indexes, RPCs, and Storage policies.
2. `20260928175110_create_chat_tables_with_rls.sql` — owner-scoped `chats` and `messages` tables.
3. `20260928175312_auth_security_hardening.sql` — fixed search paths, least-privilege RPC grants, owner/admin checks, and explicit chat Data API grants.

All destination public tables have RLS enabled. The Security Advisor reported no anonymous `EXECUTE` access to `SECURITY DEFINER` functions. Its remaining three authenticated-only warnings are the intentional self/admin-scoped RPCs `has_role`, `create_login_challenge`, and `latest_login_challenge_status`.

## Data transferred and verified

Current source and destination counts match:

- Catalog: 2 titles, 0 genres, 0 title/genre links, 2 chapters, 47 pages, 0 chapter voiceovers, and 1 ad.
- Auth: 6 users and 6 email identities; 2 users are confirmed and 4 are unconfirmed. Stable user/role fingerprints match between projects. Password hashes were preserved; existing sessions do not transfer because the destination uses a different JWT secret.
- User-linked records: 2 `user_roles`, 2 `admin_requests`, and 1 encrypted `user_api_keys` record are present on the destination with matching stable-ID fingerprints. Login challenges and rate-limit history are transient and start fresh.
- Storage: all 98 objects are present — 48 private objects in `hikko-originals`, 49 public objects in `manga`, and 1 in `title-covers`. The copy was SHA-256 verified; current source/destination bucket counts still match. The other configured buckets are empty.
- Public app URLs were rewritten: 2 `titles.cover_url` values and 47 `pages.image_url` values now use the destination host. A public object smoke test returned HTTP 200 for both `manga` and `title-covers`. No old-project host was found in the remaining checked URL columns.
- `pages.original_url` values were intentionally not copied; some may be private or expiring links.
- A source signup created after the initial copy was subsequently transferred with its email identity and password hash. Its unconfirmed status was preserved; the hash fingerprint matched across projects.

## Auth settings

- The public Auth settings endpoint reports `mailer_autoconfirm=true` on the destination, so email confirmation is **disabled for new email signups**.
- Existing unconfirmed accounts remain unconfirmed; the setting change did not retroactively mark their email addresses verified.
- Site URL and redirect allowlist still need to be saved/verified in **Authentication → URL Configuration**. The Supabase Dashboard required a sign-in, and the user chose not to use browser takeover, so those Dashboard settings were not changed here.

Set:

- **Site URL:** `https://hikkogpt.vercel.app`
- **Redirect allowlist:**
  - `https://hikkogpt.vercel.app/**`
  - `https://hikkogpt-*.vercel.app/**`
  - `http://localhost:5173/**`
  - `http://127.0.0.1:5173/**`

Consider enabling leaked-password protection if available. Configure custom SMTP if production email volume exceeds the built-in service's limits. Never put SMTP credentials in this repository.

## Edge Functions and secrets

All 15 app Edge Functions are active on the destination with the intended gateway JWT policies. Two temporary migration helper functions also remain deployed (`migration-presign` on the source and `migration-copy` on the destination); both have `verify_jwt=true` and were inspected to return HTTP 410 without exposing data. They are not part of the app and are safe-disabled, but can be deleted later through an authorized Dashboard/API workflow.

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` into the Edge runtime. Confirm/configure feature secrets in **Project Settings → Edge Functions → Secrets**; secret values were not read or copied in this continuation:

- Submission protection: `RATE_LIMIT_SALT`, `CAPTCHA_PROVIDER`, and either `TURNSTILE_SECRET_KEY` or `HCAPTCHA_SECRET_KEY`.
- Encrypted per-user API keys: `USER_KEY_ENC_SECRET`. Use the **exact source-project value** to keep the existing ciphertext readable; do not rotate it unless stored keys are re-encrypted first.
- AI/provider features: `GEMINI_API_KEYS`, `GEMINI_CHAT_MODEL`, `GEMINI_ANALYST_MODEL`, `GEMINI_LIVE_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_VISION_MODEL`, `FIRECRAWL_API_KEY`, `ELEVENLABS_API_KEY`, `LOVABLE_API_KEY`, and `XAI_API_KEY` for direct Grok chat. `GROK_CHAT_MODEL` is optional and defaults to `grok-4.7`; Grok chat falls back to Lovable, then Gemini.
- Login notifications: `RESEND_API_KEY`, `OWNER_NOTIFY_EMAIL`, and `OWNER_NOTIFY_FROM`.

Configure only the providers/features the app uses. Do not paste secret values in chat, SQL, GitHub, or frontend `VITE_*` variables. Use Supabase's secret editor or a secure local secret manager.

## Remaining cutover checklist

- [x] Apply schema/security migrations and transfer app/catalog/Auth data.
- [x] Copy and SHA-256 verify all 98 Storage objects; keep `hikko-originals` private.
- [x] Rewrite public image/cover URLs and smoke-test public reads.
- [x] Disable email confirmation for new email signups (`mailer_autoconfirm=true`).
- [ ] Save the Auth Site URL and redirect allowlist above in the destination Dashboard.
- [ ] Confirm/set required Edge Function secrets, especially the source-compatible `USER_KEY_ENC_SECRET`.
- [ ] Reauthorize the Vercel connector for team scope `dmloaderjavas-projects`.
- [ ] Update Vercel production/preview/development values for `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY` to the destination, then deploy from `main`.
- [ ] Verify production login/recovery, catalog images, chat/AI functions, and RLS after deployment. Keep the source project intact until cutover validation is complete.
