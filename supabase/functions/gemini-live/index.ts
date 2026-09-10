// Gemini Multimodal Live API WebSocket proxy.
// The browser never sees the Google API key: it connects here with the user's
// JWT (query param, since browsers cannot set WS headers) and we relay frames.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const MODELS = [
  Deno.env.get("GEMINI_LIVE_MODEL") || "models/gemini-2.0-flash-live-001",
  "models/gemini-live-2.5-flash-preview",
  "models/gemini-2.0-flash-exp",
].filter((m, i, a) => a.indexOf(m) === i);

function getKeys(): string[] {
  const raw = Deno.env.get("GEMINI_API_KEYS") || "";
  return raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
}

function upstreamUrl(model: string, key: string) {
  const base =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  return `${base}?key=${encodeURIComponent(key)}&model=${encodeURIComponent(model)}`;
}

Deno.serve(async (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return new Response("Unauthorized", { status: 401 });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return new Response("Unauthorized", { status: 401 });

  const keys = getKeys();
  if (keys.length === 0) return new Response("Voice mode is not configured", { status: 503 });

  const { socket: client, response } = Deno.upgradeWebSocket(req);

  let upstream: WebSocket | null = null;
  let openedOnce = false;
  const pending: string[] = [];
  let attempt = 0;

  const combos: { model: string; key: string }[] = [];
  for (const model of MODELS) for (const key of keys) combos.push({ model, key });

  const fail = (msg: string) => {
    try {
      client.send(JSON.stringify({ proxyError: msg }));
    } catch { /* ignore */ }
    try { client.close(1011, "upstream failed"); } catch { /* ignore */ }
  };

  const connect = () => {
    if (attempt >= combos.length) return fail("Не удалось подключиться к Gemini Live");
    const { model, key } = combos[attempt++];
    const ws = new WebSocket(upstreamUrl(model, key));
    upstream = ws;

    ws.onopen = () => {
      openedOnce = true;
      while (pending.length) {
        const msg = pending.shift();
        if (msg) ws.send(msg);
      }
    };
    ws.onmessage = async (ev) => {
      try {
        const payload = ev.data instanceof Blob ? await ev.data.text() : ev.data;
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      } catch (e) {
        console.error("relay->client failed", e);
      }
    };
    ws.onerror = () => {
      if (!openedOnce) connect();
    };
    ws.onclose = (ev) => {
      // Retry the next model/key only if the session never produced traffic.
      if (!openedOnce) { connect(); return; }
      try { client.close(1000, ev.reason || "upstream closed"); } catch { /* ignore */ }
    };
  };

  client.onopen = () => connect();
  client.onmessage = (ev) => {
    const payload = typeof ev.data === "string" ? ev.data : "";
    if (!payload) return;
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(payload);
    else pending.push(payload);
  };
  client.onclose = () => {
    try { upstream?.close(); } catch { /* ignore */ }
  };
  client.onerror = () => {
    try { upstream?.close(); } catch { /* ignore */ }
  };

  return response;
});
