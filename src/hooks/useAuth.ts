import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { User, Session } from "@supabase/supabase-js";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    let authEventCount = 0;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      authEventCount += 1;
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setLoading(false);
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted || authEventCount > 0) return;
      if (error) console.error("Failed to read Supabase session:", error);
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    }).catch((error: unknown) => {
      if (!mounted || authEventCount > 0) return;
      console.error("Failed to initialize Supabase auth:", error);
      setSession(null);
      setUser(null);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.warn("Supabase signOut error:", error);
      }
    } catch (error: unknown) {
      console.warn("Sign out exception:", error);
    } finally {
      setSession(null);
      setUser(null);
      toast.success("Вы вышли из аккаунта");
    }
  };

  return { user, session, loading, signOut };
}
