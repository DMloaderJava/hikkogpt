import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  buildAttempts,
  extractTtsPcm,
  geminiGenerate,
  parseProvider,
  parseServerKeys,
  providerResponseHeaders,
  resolveClientKeys,
  resolveStartIndex,
  type AiProvider,
  type KeyAttempt,
  type KeySource,
} from "../_shared/gemini.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Expose-Headers': 'x-ai-provider, x-ai-key-source, x-ai-key-index',
};

const ALLOWED_VOICES = ['Charon', 'Kore', 'Puck', 'Aoede', 'Fenrir', 'Leda', 'Zephyr', 'Orus'];
const MAX_SPEAKERS = 8;
const LOVABLE_TTS_MODEL = 'google/gemini-3.1-flash-tts-preview';
const GEMINI_TTS_MODELS = [
  ...new Set([Deno.env.get("GEMINI_TTS_MODEL") || "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"]),
];

interface Line { speaker: string; text: string }

function parseTranscript(transcript: string): Line[] {
  const lines: Line[] = [];
  for (const raw of transcript.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^Speaker\s*(\d{1,2})\s*:\s*(.+)$/i);
    if (m) {
      lines.push({ speaker: m[1], text: m[2].trim() });
    } else if (lines.length) {
      lines[lines.length - 1].text += ' ' + line;
    }
  }
  return lines;
}

// --- WAV helpers ---
function findDataChunk(bytes: Uint8Array): { offset: number; length: number; sampleRate: number; channels: number; bits: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let sampleRate = 24000, channels = 1, bits = 16;
  while (pos + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(pos + 10, true);
      sampleRate = view.getUint32(pos + 12, true);
      bits = view.getUint16(pos + 22, true);
    } else if (id === 'data') {
      return { offset: pos + 8, length: Math.min(size, bytes.byteLength - pos - 8), sampleRate, channels, bits };
    }
    pos += 8 + size + (size % 2);
  }
  // No header found — treat whole payload as raw PCM
  return { offset: 0, length: bytes.byteLength, sampleRate, channels, bits };
}

function buildWav(pcm: Uint8Array, sampleRate: number, channels: number, bits: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const write = (o: number, s: string) => { for (let i = 0; i < s.length; i++) header[o + i] = s.charCodeAt(i); };
  const byteRate = sampleRate * channels * (bits / 8);
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  write(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(header.byteLength + pcm.byteLength);
  out.set(header, 0);
  out.set(pcm, header.byteLength);
  return out;
}

function silence(ms: number, sampleRate: number, channels: number, bits: number): Uint8Array {
  const frames = Math.round((sampleRate * ms) / 1000);
  return new Uint8Array(frames * channels * (bits / 8));
}

// --- Backends ---

type Backend = "lovable" | "gemini";

class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface SynthResult {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
  bits: number;
  backend: Backend;
  source: KeySource;
  userIndex: number;
}

/** Пейлоад в нативном формате Gemini TTS (Lovable gateway принимает его как есть + model). */
function ttsPayload(text: string, speechConfig: Record<string, unknown>) {
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      temperature: 1,
      responseModalities: ['AUDIO'],
      speechConfig,
    },
  };
}

async function synthLovable(
  payload: ReturnType<typeof ttsPayload>,
  apiKey: string,
): Promise<Omit<SynthResult, "backend" | "source" | "userIndex">> {
  const response = await fetch('https://ai.gateway.lovable.dev/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: LOVABLE_TTS_MODEL, ...payload }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error(`dialog-tts lovable failed [${response.status}]:`, errText.slice(0, 200));
    throw new UpstreamError(response.status, errText.slice(0, 200) || `Lovable TTS error ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const info = findDataChunk(bytes);
  return {
    pcm: bytes.slice(info.offset, info.offset + info.length),
    sampleRate: info.sampleRate,
    channels: info.channels,
    bits: info.bits,
  };
}

async function synthGemini(
  payload: ReturnType<typeof ttsPayload>,
  attempts: KeyAttempt[],
): Promise<Omit<SynthResult, "backend">> {
  const res = await geminiGenerate(attempts, GEMINI_TTS_MODELS, payload, { label: "dialog-tts" });
  if (!res.ok) throw new UpstreamError(res.status, res.message);
  const pcm = extractTtsPcm(res.data);
  if (!pcm) throw new UpstreamError(502, "Нет аудио в ответе модели");
  return {
    pcm: pcm.bytes,
    sampleRate: pcm.sampleRate,
    channels: pcm.channels,
    bits: pcm.bits,
    source: res.source,
    userIndex: res.userIndex,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return json({ error: 'Unauthorized' }, 401);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json();
    const transcript: string = (body?.transcript ?? '').toString().slice(0, 6000);
    if (!transcript.trim()) return json({ error: 'Пустой текст' }, 400);

    const requestedProvider: AiProvider = parseProvider(body?.provider);
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    const clientKeys = resolveClientKeys(body?.userKeys);
    const attempts = buildAttempts(clientKeys, resolveStartIndex(body?.userKeyIndex), parseServerKeys(Deno.env.get("GEMINI_API_KEYS")));

    if (!LOVABLE_API_KEY && attempts.length === 0) return json({ error: 'AI не настроен' }, 500);

    // voices: { "1": "Charon", "2": "Kore", ... }; legacy voice1/voice2 still supported
    const rawVoices: Record<string, unknown> = (body?.voices && typeof body.voices === 'object')
      ? body.voices
      : { '1': body?.voice1, '2': body?.voice2 };
    const voiceFor = (speaker: string) => {
      const v = rawVoices[speaker];
      if (typeof v === 'string' && ALLOWED_VOICES.includes(v)) return v;
      const idx = (parseInt(speaker, 10) - 1) % ALLOWED_VOICES.length;
      return ALLOWED_VOICES[idx >= 0 ? idx : 0];
    };

    const lines = parseTranscript(transcript);
    if (!lines.length) {
      return json({ error: 'Не найдено реплик. Формат: "Speaker 1: текст"' }, 400);
    }

    const speakers = [...new Set(lines.map((l) => l.speaker))];
    if (speakers.length > MAX_SPEAKERS) {
      return json({ error: `Слишком много голосов (максимум ${MAX_SPEAKERS}).` }, 400);
    }

    const mapError = (status: number) => {
      if (status === 429) return json({ error: 'Слишком много запросов, попробуйте чуть позже.' }, 429);
      if (status === 402) return json({ error: 'Недостаточно средств Lovable AI.' }, 402);
      if (status === 400) return json({ error: 'Не удалось озвучить этот текст. Проверьте формат реплик.' }, 400);
      return json({ error: 'Озвучка не удалась. Попробуйте снова.' }, 500);
    };

    /** Один синтез: primary-бэкенд, при ошибке — запасной (если настроен). */
    const synthesize = async (payload: ReturnType<typeof ttsPayload>): Promise<SynthResult> => {
      const order: Backend[] = [requestedProvider, requestedProvider === "lovable" ? "gemini" : "lovable"];
      let lastError: UpstreamError = new UpstreamError(500, "AI недоступен");
      for (const backend of order) {
        try {
          if (backend === "lovable") {
            if (!LOVABLE_API_KEY) continue;
            const r = await synthLovable(payload, LOVABLE_API_KEY);
            return { ...r, backend, source: "lovable", userIndex: -1 };
          } else {
            if (attempts.length === 0) continue;
            const r = await synthGemini(payload, attempts);
            return { ...r, backend };
          }
        } catch (e) {
          lastError = e instanceof UpstreamError ? e : new UpstreamError(500, e instanceof Error ? e.message : "TTS error");
          console.warn(`dialog-tts: backend ${backend} failed:`, lastError.message);
        }
      }
      throw lastError;
    };

    const audioResponse = (wav: Uint8Array, meta: Pick<SynthResult, "backend" | "source" | "userIndex">) =>
      new Response(wav, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'audio/wav',
          ...providerResponseHeaders(meta.backend, meta.source, meta.userIndex),
        },
      });

    // 1–2 speakers: single request with Gemini multi-speaker (best quality/prosody)
    if (speakers.length <= 2) {
      const speakerVoiceConfigs = speakers.map((s) => ({
        speaker: `Speaker ${s}`,
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceFor(s) } },
      }));
      const text = lines.map((l) => `Speaker ${l.speaker}: ${l.text}`).join('\n');

      let result: SynthResult;
      try {
        result = await synthesize(ttsPayload(
          `## Transcript:\n${text}`,
          speakers.length === 2
            ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs } }
            : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceFor(speakers[0]) } } },
        ));
      } catch (e) {
        return mapError(e instanceof UpstreamError ? e.status : 500);
      }

      return audioResponse(buildWav(result.pcm, result.sampleRate, result.channels, result.bits), result);
    }

    // 3+ speakers: synthesize each line separately, then stitch into one WAV
    if (lines.length > 40) {
      return json({ error: 'Слишком много реплик для 3+ голосов (максимум 40).' }, 400);
    }

    const parts: Uint8Array[] = [];
    let sampleRate = 24000, channels = 1, bits = 16;
    let lastMeta: Pick<SynthResult, "backend" | "source" | "userIndex"> = { backend: requestedProvider, source: "lovable", userIndex: -1 };

    for (const line of lines) {
      let result: SynthResult;
      try {
        result = await synthesize(ttsPayload(line.text, {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceFor(line.speaker) } },
        }));
      } catch (e) {
        console.error(`dialog-tts line failed:`, e);
        return mapError(e instanceof UpstreamError ? e.status : 500);
      }
      sampleRate = result.sampleRate;
      channels = result.channels;
      bits = result.bits;
      lastMeta = result;
      parts.push(result.pcm);
      parts.push(silence(220, sampleRate, channels, bits));
    }

    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { pcm.set(p, offset); offset += p.byteLength; }

    return audioResponse(buildWav(pcm, sampleRate, channels, bits), lastMeta);
  } catch (error) {
    console.error('dialog-tts error:', error);
    return json({ error: 'Озвучка не удалась. Попробуйте снова.' }, 500);
  }
});
