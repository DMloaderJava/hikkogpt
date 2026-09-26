/**
 * Пример 3 — подключение из React-приложения (этот репозиторий).
 *
 * Файл не импортируется сборкой Vite, это готовый шаблон: скопируйте хук
 * в `src/hooks/`. Прокси в `vite.config.ts` уже настроен — достаточно поднять
 * API и сообщить Vite его адрес:
 *
 * ```bash
 * node api/src/server.ts                                  # терминал 1
 * VITE_PRIVATE_API_URL=http://127.0.0.1:8787 npm run dev   # терминал 2
 * ```
 *
 * Тогда браузер ходит относительными URL `/private-api/...` (без CORS-проблем).
 *
 * Браузер НЕ должен знать секрет: здесь используется JWT текущего пользователя
 * Supabase — сервер сам достанет из него e-mail и сверит с белым списком.
 */
import { useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HikkoApiClient } from "../../../api/client/src/client";

const API_BASE = "/private-api"; // через Vite-прокси → http://127.0.0.1:8787

export function usePrivateApi() {
  const clientRef = useRef<HikkoApiClient | null>(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Клиент создаётся заново при каждом входе: JWT живёт ~1 час. */
  const client = useCallback(async (): Promise<HikkoApiClient> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return new HikkoApiClient({
      baseUrl: API_BASE,
      apiKey: session?.access_token ?? "",
    });
  }, []);

  const ask = useCallback(
    async (question: string) => {
      setLoading(true);
      setError(null);
      setAnswer("");
      try {
        const api = await client();
        clientRef.current = api;
        for await (const piece of api.chatStream([{ role: "user", content: question }])) {
          setAnswer((prev) => prev + piece);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  return { ask, answer, loading, error };
}
