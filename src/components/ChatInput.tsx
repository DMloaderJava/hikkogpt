import { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, Paperclip } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  isStreaming: boolean;
  onStop: () => void;
}

export function ChatInput({ onSend, isStreaming, onStop }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [value]);

  const handleSubmit = () => {
    if (isStreaming) {
      onStop();
      return;
    }
    if (!value.trim()) return;
    onSend(value.trim());
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="relative flex items-end rounded-2xl border border-border bg-secondary/50 shadow-sm transition-colors focus-within:border-ring/50">
        <button
          className="flex-shrink-0 p-3 text-muted-foreground hover:text-foreground transition-colors"
          title="Прикрепить файл"
        >
          <Paperclip className="h-5 w-5" />
        </button>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Напишите сообщение..."
          rows={1}
          className="flex-1 resize-none bg-transparent py-3 pr-2 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />

        <button
          onClick={handleSubmit}
          disabled={!isStreaming && !value.trim()}
          className={`m-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
            isStreaming
              ? "bg-foreground text-background"
              : value.trim()
              ? "bg-foreground text-background hover:opacity-80"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          }`}
        >
          {isStreaming ? (
            <Square className="h-3.5 w-3.5" fill="currentColor" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </div>

      <p className="mt-2 text-center text-xs text-muted-foreground">
        ChatGPT может допускать ошибки. Проверяйте важную информацию.
      </p>
    </div>
  );
}
