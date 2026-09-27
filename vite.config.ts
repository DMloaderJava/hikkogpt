import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Переменные окружения читаем сами: в config-файле `import.meta.env` недоступен,
  // а `process.env` не знает про .env-файлы проекта.
  const env = loadEnv(mode, process.cwd(), "");
  const supabaseUrl = env.VITE_SUPABASE_URL;

  /**
   * Edge-функции Supabase в dev идут через этот прокси: браузер обращается к
   * своему же origin (`/functions/v1/...`), поэтому на запрос не влияют CORS,
   * блокировщики рекламы и ограничения сети в песочницах/превью. Заголовки
   * `Authorization` и `apikey` по-прежнему добавляет клиент (src/lib/edgeAuth.ts).
   */
  const edgeProxy = supabaseUrl
    ? {
        "/functions/v1": {
          target: `${supabaseUrl}/functions/v1`,
          changeOrigin: true,
          secure: true,
          /**
           * Прокси отвечает читаемой причиной, если сам не достучался до Supabase.
           *
           * Без этого браузер получает пустой `500 text/plain`, а клиент — нечего
           * показать кроме «Ошибка 500»: в песочницах/превью выход к
           * `*.supabase.co` закрыт, и запрос до функции не доходит вовсе. С телом
           * `{ error }` пользователь видит настоящую причину (прокси, а не api),
           * а `edgeAuth` разбирает её как любой другой ответ сервера.
           */
          configure(proxy: {
            on: (event: string, handler: (...args: unknown[]) => void) => void;
          }) {
            proxy.on("error", (...args: unknown[]) => {
              const err = args[0] as Error | undefined;
              const res = args[2] as
                | {
                    headersSent?: boolean;
                    writeHead?: (code: number, headers: Record<string, string>) => void;
                    end?: (body?: string) => void;
                  }
                | undefined;
              if (!res || !res.writeHead || !res.end || res.headersSent) return;
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: `Dev-прокси не достучался до Supabase: ${err?.message ?? "сеть недоступна"}. Запрос к функции не уходил — проверьте выход в сеть там, где запущен dev-сервер.`,
                })
              );
            });
          },
        },
      }
    : undefined;

  return {
    server: {
      host: "::",
      port: 8080,
      ...(edgeProxy ? { proxy: edgeProxy } : {}),
      // Хосты превью-песочниц и туннелей (Vite 5.4+ иначе отвечает 403 на чужой
      // Host). Точка в начале = домен и все его поддомены. На localhost не влияет.
      allowedHosts: [".e2b.app"],
      hmr: {
        overlay: false,
      },
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
