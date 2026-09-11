// Gemini Multimodal Live API WebSocket proxy.
// The browser never sees the Google API key: it connects here with the user's
// JWT (query param, since browsers cannot set WS headers) and we relay frames.
//
// Деплой: нужен [functions.gemini-live] verify_jwt = false в supabase/config.toml.
// Платформенная проверка JWT отклоняет браузерный handshake (заголовок
// Authorization поставить нечем) ещё до того, как выполнится этот код.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

/**
 * Модели для ротации «модель × ключ». Держите в согласии с DEFAULT_LIVE_MODEL и
 * DEFAULT_LIVE_MODEL_FALLBACKS в src/types/gemini-live.ts.
 *
 * Внимание: `gemini-2.0-flash-live-001` и `gemini-live-2.5-flash-preview` Google
 * отключил 09.12.2025 — они в конце списка только как страховка на время, пока
 * секрет GEMINI_LIVE_MODEL не переопределён.
 */
const MODELS = [
  Deno.env.get("GEMINI_LIVE_MODEL") || "models/gemini-3.1-flash-live-preview",
  "models/gemini-2.5-flash-native-audio-preview-12-2025",
  "models/gemini-2.0-flash-live-001",
  "models/gemini-live-2.5-flash-preview",
].filter((m, i, a) => a.indexOf(m) === i);

/**
 * Сколько ждать setupComplete от Google, прежде чем считать пару «модель × ключ»
 * мёртвой и перейти к следующей. Google принимает WebSocket-апгрейд даже для
 * недоступной модели или неверного ключа, а ошибку отдаёт позже, поэтому
 * ориентироваться на onopen нельзя.
 */
const SETUP_TIMEOUT_MS = 6000;

/** Код закрытия: апстрим так и не поднялся, все пары «модель × ключ» исчерпаны. */
const CLOSE_SETUP_FAILED = 4408;

/** Код закрытия: сессия работала и закрылась на стороне Google. */
const CLOSE_SESSION_ENDED = 4410;

function getKeys(): string[] {
  const raw = Deno.env.get("GEMINI_API_KEYS") || "";
  return raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
}

function upstreamUrl(model: string, key: string) {
  const base =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  return `${base}?key=${encodeURIComponent(key)}&model=${encodeURIComponent(model)}`;
}

/** Уже после апгрейда Google может прислать setupComplete — это и есть «сессия поднялась». */
function isSetupComplete(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown> | null;
    return !!parsed && typeof parsed === "object" && "setupComplete" in parsed;
  } catch {
    return false;
  }
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
  /** Сессия считалась рабочей: setupComplete дошёл до клиента. */
  let sessionReady = false;
  /** Апстрим открыт, но setupComplete ещё не подтверждён. */
  let awaitingSetup = false;
  let attemptTimer: number | null = null;
  const pending: string[] = [];
  let attempt = 0;
  let failed = false;

  const combos: { model: string; key: string }[] = [];
  for (const model of MODELS) for (const key of keys) combos.push({ model, key });

  const clearAttemptTimer = () => {
    if (attemptTimer !== null) {
      clearTimeout(attemptTimer);
      attemptTimer = null;
    }
  };

  const sendToClient = (payload: unknown, fallbackCode = CLOSE_SETUP_FAILED, reason = "") => {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(JSON.stringify(payload));
    } catch { /* клиент уже отключился */ }
    try { client.close(fallbackCode, reason); } catch { /* уже закрыт */ }
  };

  /** Все пары «модель × ключ» перебраны — клиенту нужен внятный текст, а не «сессия закрыта». */
  const fail = (msg: string) => {
    if (failed) return;
    failed = true;
    clearAttemptTimer();
    sendToClient(
      { upstreamError: { code: CLOSE_SETUP_FAILED, reason: msg } },
      CLOSE_SETUP_FAILED,
      "upstream setup failed",
    );
  };

  const connect = () => {
    if (failed) return;
    if (client.readyState !== WebSocket.OPEN) return;
    if (attempt >= combos.length) {
      return fail("Не удалось подключиться к Gemini Live: проверьте GEMINI_API_KEYS и GEMINI_LIVE_MODEL.");
    }

    const { model, key } = combos[attempt++];
    const ws = new WebSocket(upstreamUrl(model, key));
    upstream = ws;
    awaitingSetup = true;

    // Google умеет принять апгрейд и промолчать (недоступная модель, ключ без
    // доступа, региональные ограничения). Без watchdog такая попытка висела бы
    // до бесконечности, а ротация ключей не срабатывала бы.
    clearAttemptTimer();
    attemptTimer = setTimeout(() => {
      attemptTimer = null;
      if (!awaitingSetup || sessionReady) return;
      awaitingSetup = false;
      try { ws.close(4001, "setup timeout"); } catch { /* уже закрыт */ }
      connect();
    }, SETUP_TIMEOUT_MS);

    ws.onopen = () => {
      // Сообщаем клиенту, какая модель реально открылась (ключи и модели
      // ротируются), и только после этого он шлёт setup — так setup.model не
      // разъедется с model в URL апстрима.
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ proxyInfo: { model } }));
        }
      } catch (e) {
        console.error("proxyInfo -> client failed", e);
      }
      while (pending.length) {
        const msg = pending.shift();
        if (msg) ws.send(msg);
      }
    };

    ws.onmessage = async (ev) => {
      // Сокет уже заменён ротацией (watchdog / следующая попытка) — его кадры
      // не должны попадать клиенту.
      if (ws !== upstream) return;
      try {
        const payload = ev.data instanceof Blob ? await ev.data.text() : ev.data;
        const text = typeof payload === "string" ? payload : String(payload ?? "");
        if (isSetupComplete(text)) {
          awaitingSetup = false;
          sessionReady = true;
          clearAttemptTimer();
        }
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      } catch (e) {
        console.error("relay->client failed", e);
      }
    };

    ws.onerror = () => {
      if (ws !== upstream) return;
      // Ошибка до подтверждённого setup — просто пробуем следующую пару.
      if (!sessionReady && !failed) {
        clearAttemptTimer();
        awaitingSetup = false;
        connect();
      }
    };

    ws.onclose = (ev) => {
      // Сокет, который watchdog уже закрыл сам, не должен запускать ещё одну
      // ротацию: иначе следующая пара «модель × ключ» пропускалась бы.
      if (ws !== upstream) return;
      clearAttemptTimer();

      // Сессия не поднялась: ротация продолжается — это самый частый сценарий
      // (устаревшая/недоступная модель, ключ без доступа к Live API).
      if (!sessionReady && !failed) {
        awaitingSetup = false;
        connect();
        return;
      }
      if (failed) return;

      // Сессия работала и закрылась на стороне Google: это не «нормальное»
      // завершение, а конец разговора (лимит ~10–15 минут без session resumption).
      const reason = ev.reason?.trim();
      sendToClient(
        { sessionClosed: { reason: reason || undefined } },
        CLOSE_SESSION_ENDED,
        reason || "upstream closed",
      );
    };
  };

  client.onopen = () => connect();

  client.onmessage = (ev) => {
    const payload = typeof ev.data === "string" ? ev.data : "";
    if (!payload) return;
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(payload);
    else pending.push(payload);
  };

  const shutdown = () => {
    failed = true;
    clearAttemptTimer();
    try { upstream?.close(); } catch { /* уже закрыт */ }
  };

  client.onclose = shutdown;
  client.onerror = shutdown;

  return response;
});
