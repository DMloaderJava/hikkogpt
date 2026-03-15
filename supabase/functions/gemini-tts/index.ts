import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Map our voice IDs to OpenAI TTS voice names
const VOICE_MAP: Record<string, string> = {
  Aoede: 'nova',
  Charon: 'onyx',
  Fenrir: 'echo',
  Kore: 'shimmer',
  Puck: 'fable',
  Leda: 'alloy',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const { text, voice = 'Aoede' } = await req.json();

    if (!text) {
      return new Response(JSON.stringify({ error: 'No text provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const openaiVoice = VOICE_MAP[voice] || 'nova';

    // Use OpenAI TTS via Lovable AI gateway
    const response = await fetch('https://ai.gateway.lovable.dev/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/tts-1',
        input: text.slice(0, 4096),
        voice: openaiVoice,
        response_format: 'mp3',
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Превышен лимит запросов, попробуйте позже.' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: 'Недостаточно средств. Пополните баланс Lovable AI.' }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const errorText = await response.text();
      throw new Error(`TTS failed [${response.status}]: ${errorText}`);
    }

    // Return audio stream directly
    return new Response(response.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'audio/mpeg',
      },
    });

  } catch (error) {
    console.error('TTS error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
