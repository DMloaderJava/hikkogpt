// Public one-time approval endpoint for links sent to an administrator's email.
// Gateway JWT verification is disabled in supabase/config.toml because the
// 256-bit token is the credential; the database RPC is called only as service_role.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  if (!isRecord(requestBody)) return json(400, { ok: false, error: "invalid_request" });

  const token = typeof requestBody.token === "string" ? requestBody.token.trim() : "";
  const action = typeof requestBody.action === "string" ? requestBody.action.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/i.test(token) || (action !== "approve" && action !== "deny")) {
    return json(400, { ok: false, error: "token_and_valid_action_required" });
  }

  const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!projectUrl || !serviceRoleKey) return json(500, { ok: false, error: "config_missing" });

  const admin = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc("resolve_login_challenge", {
    p_token: token,
    p_action: action,
  });
  if (error) {
    // Do not expose database internals or token details to the public caller.
    console.error("login-confirm RPC failed", error.code ?? "unknown");
    return json(500, { ok: false, error: "challenge_resolution_failed" });
  }

  const status = typeof data === "string" ? data : "error";
  const ok = ["approved", "denied", "already_approved", "already_denied"].includes(status);
  return json(ok ? 200 : 400, { ok, status });
});
