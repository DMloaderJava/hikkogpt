import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data.user) return json({ error: 'Unauthorized' }, 401);
    const { images } = await req.json();
    if (!Array.isArray(images) || images.length < 1 || images.length > 5 || images.some((image: unknown) => typeof image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 14000000)) return json({ error: 'Отправьте от 1 до 5 изображений PNG, JPEG или WebP до 10 МБ' }, 400);
    const key = Deno.env.get('LOVABLE_API_KEY');
    if (!key) return json({ error: 'AI не настроен' }, 500);
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-3-flash-preview', stream: false, messages: [
        { role: 'system', content: 'Ты анализируешь мангу. Ответь ТОЛЬКО валидным JSON: {"pages":[{"description":"краткое описание сцены на русском","transcript":"Speaker 1: текст\\nSpeaker 2: текст"}]}. Ровно один элемент pages на каждое изображение в том же порядке. Сохраняй номера говорящих персонажей между страницами. Передай видимые реплики на русском; если текста нет, придумай краткую реплику по сцене и обозначь это в description. Не более 8 персонажей. Без markdown.' },
        { role: 'user', content: [{ type: 'text', text: `Проанализируй ${images.length} страниц манги по порядку.` }, ...images.map((url: string) => ({ type: 'image_url', image_url: { url } }))] },
      ] }),
    });
    if (!response.ok) return json({ error: 'Ошибка анализа изображений' }, response.status);
    const result = await response.json();
    const raw = result.choices?.[0]?.message?.content?.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const pages = JSON.parse(raw).pages;
    if (!Array.isArray(pages) || pages.length !== images.length || pages.some((p: any) => typeof p.description !== 'string' || typeof p.transcript !== 'string')) return json({ error: 'Неверный ответ анализа, попробуйте снова' }, 502);
    return json({ pages: pages.map((p: any) => ({ description: p.description.slice(0, 2000), transcript: p.transcript.slice(0, 6000) })) });
  } catch (e) { return json({ error: e instanceof Error ? e.message : 'Ошибка анализа' }, 500); }
});
