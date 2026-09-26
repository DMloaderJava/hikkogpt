import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    // Хосты превью-песочниц и туннелей (Vite 5.4+ иначе отвечает 403 на чужой
    // Host). Точка в начале = домен и все его поддомены. На localhost не влияет.
    allowedHosts: [".e2b.app"],
    hmr: {
      overlay: false,
    },
    // Прокси для приватного API (api/) — нужен только если подключаете его
    // из фронтенда: браузер ходит относительным URL /private-api, а Vite
    // проксирует запросы на локальный сервер API (см. api/README.md).
    // Отключён, пока не задан VITE_PRIVATE_API_URL — на обычную разработку не влияет.
    ...(process.env.VITE_PRIVATE_API_URL
      ? {
          proxy: {
            "/private-api": {
              target: process.env.VITE_PRIVATE_API_URL,
              changeOrigin: true,
              rewrite: (p: string) => p.replace(/^\/private-api/, ""),
            },
          },
        }
      : {}),
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
