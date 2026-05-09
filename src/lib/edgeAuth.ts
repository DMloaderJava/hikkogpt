import { supabase } from "@/integrations/supabase/client";

export async function getEdgeAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return {
    Authorization: `Bearer ${session?.access_token ?? anon}`,
    apikey: anon,
  };
}
