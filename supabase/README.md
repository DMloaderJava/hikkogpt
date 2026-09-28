# Supabase operations

Project: `islgkqdsztchzajnulof`
Production app: `https://hikkogpt.vercel.app`

## Auth redirects to configure in Dashboard

Set **Site URL** to `https://hikkogpt.vercel.app`. Add these **Redirect URLs**:

- `https://hikkogpt.vercel.app`
- `https://hikkogpt.vercel.app/auth?mode=reset`
- `https://hikkogpt-*-dmloaderjavas-projects.vercel.app/**`
- `http://localhost:5173/**`
- `http://127.0.0.1:5173/**`

Enable **Leaked password protection** if the project's plan exposes the option. Use the Supabase dashboard's SMTP settings to configure a custom mail provider if the built-in email rate limit causes signup or recovery `429` responses. Never store SMTP credentials in this repository.

## Edge Function secrets

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Never copy the service-role key into frontend code or `VITE_*` variables.

Application secrets used by this code include:

- `RATE_LIMIT_SALT` and either `TURNSTILE_SECRET_KEY` (default provider) or `HCAPTCHA_SECRET_KEY` for anonymous title submission and status rate limits. `CAPTCHA_PROVIDER` selects `turnstile` or `hcaptcha`.
- `USER_KEY_ENC_SECRET` for AES-256-GCM encryption of per-user API keys. **Do not rotate it unless existing encrypted keys have first been re-encrypted.**
- Optional provider/config values: `GEMINI_API_KEYS`, `GEMINI_CHAT_MODEL`, `GEMINI_ANALYST_MODEL`, `GEMINI_LIVE_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_VISION_MODEL`, `FIRECRAWL_API_KEY`, `ELEVENLABS_API_KEY`, and `LOVABLE_API_KEY`.
- Optional login notification values: `RESEND_API_KEY`, `OWNER_NOTIFY_EMAIL`, and `OWNER_NOTIFY_FROM`.

Check secret names in **Project Settings → Edge Functions → Secrets**. Secret values are not tracked here. Preserve existing encryption and provider secrets; add or rotate them only through the Supabase dashboard or secret manager.

## Function gateway policy

`submit-title`, `get-submission`, and `login-confirm` are intentionally public at the Edge gateway and enforce CAPTCHA, rate limits, or a high-entropy one-time token inside the function. `gemini-proxy` also has gateway JWT verification disabled, but validates the caller's user JWT and admin role inside the handler. Do not enable/disable gateway JWT without reviewing the handler's authentication path.

## Migration-history gap

The live project's migration history also contains these already-applied versions whose SQL files are **not present in this repository**:

- `00000000000010_submission_columns`
- `00000000000011_requests_rls_anon`
- `00000000000012_rate_limit_ip`
- `00000000000013_submissions_cleanup`
- `00000000000014_new_title_trigger`

The repository contains the chat/RLS migration and the current auth-security hardening migration. The missing historical SQL was not available through the configured Supabase tools, so it was not fabricated. **Do not run `supabase db reset` or treat this repository as a clean-room schema baseline until those migrations are recovered or a reviewed schema baseline is created.**
