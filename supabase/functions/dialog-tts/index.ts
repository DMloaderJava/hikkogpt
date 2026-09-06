import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const ALLOWED_VOICES = ['Charon', 'Kore', 'Puck', 'Aoede', 'Fenrir', 'Leda', 'Zephyr', 'Orus'];

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

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) return json({ error: 'AI не настроен' }, 500);

    const body = await req.json();
    const transcript: string = (body?.transcript ?? '').toString().slice(0, 6000);
    const voice1 = ALLOWED_VOICES.includes(body?.voice1) ? body.voice1 : 'Charon';
    const voice2 = ALLOWED_VOICES.includes(body?.voice2) ? body.voice2 : 'Kore';

    if (!transcript.trim()) return json({ error: 'Пустой текст' }, 400);

    const response = await fetch('https://ai.gateway.lovable.dev/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3.1-flash-tts-preview',
        contents: [{ role: 'user', parts: [{ text: `## Transcript:\n${transcript}` }] }],
        generationConfig: {
          temperature: 1,
          responseModalities: ['AUDIO'],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                { speaker: 'Speaker 1', voiceConfig: { prebuiltVoiceConfig: { voiceName: voice1 } } },
                { speaker: 'Speaker 2', voiceConfig: { prebuiltVoiceConfig: { voiceName: voice2 } } },
              ],
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`dialog-tts failed [${response.status}]:`, errText);
      if (response.status === 429) return json({ error: 'Слишком много запросов, попробуйте чуть позже.' }, 429);
      if (response.status === 402) return json({ error: 'Недостаточно средств Lovable AI.' }, 402);
      if (response.status === 400) return json({ error: 'Не удалось озвучить этот текст. Проверьте формат реплик.' }, 400);
      return json({ error: 'Озвучка не удалась. Попробуйте снова.' }, 500);
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, 'Content-Type': 'audio/wav' },
    });
  } catch (error) {
    console.error('dialog-tts error:', error);
    return json({ error: 'Озвучка не удалась. Попробуйте снова.' }, 500);
  }
});
