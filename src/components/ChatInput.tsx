import { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, Paperclip, X, Image } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string, imageBase64?: string) => void;
  isStreaming: boolean;
  onStop: () => void;
}

export function ChatInput({ onSend, isStreaming, onStop }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [value]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSubmit = () => {
    if (isStreaming) {
      onStop();
      return;
    }
    if (!value.trim() && !imagePreview) return;
    onSend(value.trim() || "Что на этом изображении?", imagePreview || undefined);
    setValue("");
    setImagePreview(null);
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
      {/* Image preview */}
      {imagePreview && (
        <div className="mb-2 flex items-start gap-2">
          <div className="relative">
            <img
              src={imagePreview}
              alt="Preview"
              className="h-20 w-20 rounded-lg object-cover border border-border"
            />
            <button
              onClick={() => setImagePreview(null)}
              className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      <div className="relative flex items-end rounded-2xl border border-border bg-secondary/50 shadow-sm transition-colors focus-within:border-ring/50">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileSelect}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex-shrink-0 p-3 text-muted-foreground hover:text-foreground transition-colors"
          title="Прикрепить изображение"
        >
          <Image className="h-5 w-5" />
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
          disabled={!isStreaming && !value.trim() && !imagePreview}
          className={`m-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
            isStreaming
              ? "bg-foreground text-background"
              : value.trim() || imagePreview
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
