import { useState } from "react";
import { ChatInput } from "@/components/ChatInput";

/**
 * Дев-стенд строки ввода: открывается по хэшу #input-preview (см. App.tsx).
 *
 * Сам чат живёт за авторизацией, а посмотреть раскладку кнопок и меню «+»
 * хочется без входа в аккаунт. В production-сборку файл не попадает
 * (ветка под import.meta.env.DEV вырезается).
 */
export function ChatInputDemo() {
  const [log, setLog] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const push = (line: string) => setLog((prev) => [line, ...prev].slice(0, 8));

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-sm font-semibold">Дев-стенд: строка ввода</h1>
        <p className="text-xs text-muted-foreground">
          В строке — камера, голосовой режим и диктовка. Остальное под «+»:
          на десктопе поповер, на узком экране — нижняя шторка.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {log.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Событий пока нет — отправьте сообщение или выберите пункт из «+».
          </p>
        ) : (
          <ul className="space-y-1.5">
            {log.map((line, i) => (
              <li key={i} className="rounded-lg bg-secondary/60 px-3 py-2 text-sm">
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ChatInput
        onSend={(message, images) => {
          push(`Отправлено: "${message}"${images?.length ? ` + ${images.length} фото` : ""}`);
          setIsStreaming(true);
          setTimeout(() => setIsStreaming(false), 1200);
        }}
        isStreaming={isStreaming}
        onStop={() => {
          setIsStreaming(false);
          push("Остановлено");
        }}
        onDeepSearch={(query) => push(`Глубокий поиск: "${query}"`)}
        onToggleVoiceMode={() => push("Переключён голосовой режим")}
      />
    </div>
  );
}
