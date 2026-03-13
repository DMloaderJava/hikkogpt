import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const FIRECRAWL_API_KEY = Deno.env.get('FIRECRAWL_API_KEY');
    if (!FIRECRAWL_API_KEY) {
      return new Response(JSON.stringify({ error: 'FIRECRAWL_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { query } = await req.json();
    if (!query) {
      return new Response(JSON.stringify({ error: 'Query is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Search Google Images via Firecrawl
    const searchQuery = `${query} site:*`;
    const response = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        limit: 8,
        scrapeOptions: { formats: ['links'] },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Firecrawl error [${response.status}]: ${errorText}`);
    }

    const data = await response.json();

    // Extract image-like URLs from search results
    const imageResults: { url: string; title: string; sourceUrl: string }[] = [];

    if (data.data) {
      for (const result of data.data) {
        // Check for direct image links in the result links
        const links: string[] = result.links || [];
        for (const link of links) {
          if (/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(link) && !link.includes('data:') && imageResults.length < 9) {
            imageResults.push({ url: link, title: result.title || query, sourceUrl: result.url || '' });
          }
        }
        // Use og:image or similar if available
        if (result.metadata?.ogImage && imageResults.length < 9) {
          imageResults.push({ url: result.metadata.ogImage, title: result.title || query, sourceUrl: result.url || '' });
        }
      }
    }

    return new Response(JSON.stringify({ results: imageResults, rawData: data.data?.slice(0, 5) || [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Image search error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
