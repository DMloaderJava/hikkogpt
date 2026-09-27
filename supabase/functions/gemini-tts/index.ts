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
} from "../_shared/gemini.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Expose-Headers': 'x-ai-provider, x-ai-key-source, x-ai-key-index',
};

// Map our voice IDs to OpenAI TTS voice names (Lovable path)
const VOICE_MAP: Record<string, string> = {
  Aoede: 'nova',
  Charon: 'onyx',
  Fenrir: 'echo',
  Kore: 'shimmer',
  Puck: 'fable',
  Leda: 'alloy',
};

const GEMINI_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Puck', 'Leda', 'Zephyr', 'Orus'];
const GEMINI_TTS_MODELS = [
  ...new Set([Deno.env.get("GEMINI_TTS_MODEL") || "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"]),
];

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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { text, voice = 'Aoede', provider, userKeys, userKeyIndex } = await req.json();

    if (!text) {
      return new Response(JSON.stringify({ error: 'No text provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const requestedProvider: AiProvider = parseProvider(provider);
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    const clientKeys = resolveClientKeys(userKeys);
    const attempts = buildAttempts(clientKeys, resolveStartIndex(userKeyIndex), parseServerKeys(Deno.env.get("GEMINI_API_KEYS")));

    if (!LOVABLE_API_KEY && attempts.length === 0) {
      throw new Error('AI is not configured');
    }

    type Backend = "lovable" | "gemini";
    const order: Backend[] = [requestedProvider, requestedProvider === "lovable" ? "gemini" : "lovable"];
    let lastError = "Speech generation failed. Please try again.";
    let lastStatus = 500;

    for (const backend of order) {
      // --- Lovable: OpenAI TTS через шлюз (mp3) ---
      if (backend === "lovable" && LOVABLE_API_KEY) {
        try {
          const openaiVoice = VOICE_MAP[voice] || 'nova';
          const response = await fetch('https://ai.gateway.lovable.dev/v1/audio/speech', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${LOVABLE_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'openai/tts-1',
              input: (text as string).slice(0, 4096),
              voice: openaiVoice,
              response_format: 'mp3',
            }),
          });
          if (response.ok) {
            return new Response(response.body, {
              headers: { ...corsHeaders, 'Content-Type': 'audio/mpeg', ...providerResponseHeaders("lovable", "lovable", -1) },
            });
          }
          lastStatus = response.status;
          if (response.status === 429) lastError = 'Превышен лимит запросов, попробуйте позже.';
          else if (response.status === 402) lastError = 'Недостаточно средств. Пополните баланс Lovable AI.';
          else {
            const errorText = await response.text().catch(() => '');
            console.error(`TTS lovable failed [${response.status}]:`, errorText.slice(0, 200));
          }
        } catch (e) {
          console.error('TTS lovable error:', e);
        }
        continue;
      }

      // --- Gemini direct: нативный TTS (wav) ---
      if (backend === "gemini" && attempts.length > 0) {
        const voiceName = GEMINI_VOICES.includes(voice) ? voice : 'Aoede';
        const res = await geminiGenerate(
          attempts,
          GEMINI_TTS_MODELS,
          {
            contents: [{ role: 'user', parts: [{ text: (text as string).slice(0, 4096) }] }],
            generationConfig: {
              temperature: 1,
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            },
          },
          { label: "gemini-tts" },
        );
        if (res.ok) {
          const pcm = extractTtsPcm(res.data);
          if (pcm) {
            return new Response(buildWav(pcm.bytes, pcm.sampleRate, pcm.channels, pcm.bits), {
              headers: { ...corsHeaders, 'Content-Type': 'audio/wav', ...providerResponseHeaders("gemini", res.source, res.userIndex) },
            });
          }
          lastError = 'Нет аудио в ответе модели';
          lastStatus = 502;
        } else {
          lastError = res.message;
          lastStatus = res.status;
        }
      }
    }

    return new Response(JSON.stringify({ error: lastError }), {
      status: lastStatus,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('TTS error:', error);
    return new Response(JSON.stringify({ error: 'Speech generation failed. Please try again.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
