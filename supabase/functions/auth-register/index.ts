// Регистрация без письма со ссылкой.
//
// Публичный signUp при включённом Confirm email создаёт неподтверждённый
// аккаунт и шлёт письмо. Этот обработчик вместо этого:
//   register — admin.createUser({ email_confirm: true }), письма нет;
//   confirm  — помечает уже существующий аккаунт подтверждённым, пароль не трогает.
// Сессию не выдаёт: клиент входит обычным signInWithPassword.
//
// verify_jwt = false: вызывающего ещё нет в сессии, ключ anon публичный.
// Деплой: supabase functions deploy auth-register

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isExistingUserError, parseRegisterInput } from "./logic.ts";

function pickClientIp(cfConnectingIp: string | null | undefined, xForwardedFor: string | null | undefined): string {
  const cf = cfConnectingIp?.trim();
  if (cf) return cf;
  const last = xForwardedFor?.split(",").pop()?.trim();
  return last || "unknown";
}

async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}${salt}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RATE_LIMITS = [
  { windowSeconds: 600, limit: 10 },
  { windowSeconds: 86_400, limit: 40 },
];

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

interface AdminUserRow {
  id?: string;
  email?: string | null;
}

async function findUserId(projectUrl: string, serviceKey: string, email: string): Promise<string | null> {
  for (let page = 1; page <= 5; page += 1) {
    const endpoint = new URL(`${projectUrl}/auth/v1/admin/users`);
    endpoint.searchParams.set("filter", email);
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("per_page", "50");
    const res = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { users?: AdminUserRow[] } | null;
    const users = body?.users ?? [];
    const match = users.find((user) => (user.email ?? "").trim().toLowerCase() === email);
    if (match?.id) return match.id;
    if (users.length < 50) return null;
  }
  return null;
}

async function confirmExisting(
  admin: SupabaseClient,
  projectUrl: string,
  serviceKey: string,
  email: string,
): Promise<boolean> {
  const userId = await findUserId(projectUrl, serviceKey, email);
  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, { email_confirm: true });
    if (!error) return true;
    console.error("auth-register confirm via admin API failed", error.code ?? "unknown");
  }
  // Запасной путь, если список admin API не нашёл строку (миграция confirm_auth_email).
  const { data, error } = await admin.rpc("confirm_auth_email", { p_email: email });
  if (error) {
    console.error("auth-register confirm RPC failed", error.code ?? "unknown");
    return false;
  }
  return data === true;
}

async function withinRateLimit(admin: SupabaseClient, ipHash: string): Promise<boolean> {
  for (const { windowSeconds, limit } of RATE_LIMITS) {
    const { data, error } = await admin.rpc("check_ip_rate_limit", {
      p_ip_hash: ipHash,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      // Нет соли/функции не должно закрывать регистрацию. Лимит GoTrue остаётся.
      console.error("auth-register rate limit skipped", error.code ?? "unknown");
      return true;
    }
    if (data !== true) return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!projectUrl || !serviceKey) return json(500, { ok: false, error: "config_missing" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  const parsed = parseRegisterInput(body);
  if (!parsed.ok) return json(parsed.status, { ok: false, error: parsed.error });

  const admin = createClient(projectUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ip = pickClientIp(req.headers.get("cf-connecting-ip"), req.headers.get("x-forwarded-for"));
  const salt = Deno.env.get("RATE_LIMIT_SALT") || "hikkogpt-auth-register";
  const ipHash = await hashIp(`${ip}:auth-register`, salt);
  if (!(await withinRateLimit(admin, ipHash))) {
    return json(429, { ok: false, error: "rate_limited" }, { "Retry-After": "600" });
  }

  if (parsed.action === "confirm") {
    const confirmed = await confirmExisting(admin, projectUrl, serviceKey, parsed.email);
    if (!confirmed) return json(404, { ok: false, error: "confirm_failed" });
    return json(200, { ok: true, created: false });
  }

  const { error } = await admin.auth.admin.createUser({
    email: parsed.email,
    password: parsed.password,
    email_confirm: true,
  });
  if (!error) return json(200, { ok: true, created: true });

  if (isExistingUserError(error.message ?? "", error.code)) {
    // Уже есть аккаунт: только подтвердить почту, пароль не менять.
    await confirmExisting(admin, projectUrl, serviceKey, parsed.email);
    return json(200, { ok: true, created: false });
  }

  const message = (error.message ?? "").toLowerCase();
  if (message.includes("password")) return json(400, { ok: false, error: "weak_password" });
  if (message.includes("email")) return json(400, { ok: false, error: "invalid_email" });
  console.error("auth-register createUser failed", error.code ?? "unknown");
  return json(500, { ok: false, error: "signup_failed" });
});
