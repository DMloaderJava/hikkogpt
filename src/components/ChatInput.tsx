import { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, X, Image, Search, Mic, MicOff, Loader2, Plus } from "lucide-react";
import { useVoice } from "@/hooks/useVoice";

interface ChatInputProps {
  onSend: (message: string, images?: string[]) => void;
  isStreaming: boolean;
  onStop: () => void;
  deepSearchEnabled?: boolean;
  deepSearchUsed?: boolean;
  onDeepSearch?: (query: string) => void;
}

export function ChatInput({ onSend, isStreaming, onStop, deepSearchEnabled = true, deepSearchUsed = false, onDeepSearch }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [deepSearchMode, setDeepSearchMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { state: voiceState, supported: voiceSupported, toggle: toggleVoice } = useVoice({
    onTranscript: (text) => {
      setValue((prev) => prev ? `${prev} ${text}` : text);
      textareaRef.current?.focus();
    },
  });

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
    }
  }, [value]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const validFiles = files.filter(f => f.type.startsWith("image/") && f.size <= 10 * 1024 * 1024);
    const toProcess = validFiles.slice(0, 5 - imagePreviews.length);
    toProcess.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => setImagePreviews(prev => [...prev, reader.result as string]);
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeImage = (index: number) => setImagePreviews(prev => prev.filter((_, i) => i !== index));

  const handleSubmit = () => {
    if (isStreaming) { onStop(); return; }
    if (!value.trim() && imagePreviews.length === 0) return;
    if (deepSearchMode && onDeepSearch) {
      onDeepSearch(value.trim());
      setValue("");
      setDeepSearchMode(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      return;
    }
    const text = value.trim() || (imagePreviews.length > 0 ? "Что на этих изображениях?" : "");
    onSend(text, imagePreviews.length > 0 ? imagePreviews : undefined);
    setValue("");
    setImagePreviews([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const isListening = voiceState === "listening";
  const isProcessing = voiceState === "processing";
  const canAddMore = imagePreviews.length < 5;

  return (
    <div className="mx-auto w-full max-w-3xl px-2 sm:px-4 pb-2 sm:pb-4" style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom, 8px))" }}>
      {/* Image previews */}
      {imagePreviews.length > 0 && (
        <div className="mb-2 flex items-start gap-1.5 flex-wrap">
          {imagePreviews.map((src, i) => (
            <div key={i} className="relative flex-shrink-0">
              <img src={src} alt={`Preview ${i + 1}`} className="h-14 w-14 sm:h-20 sm:w-20 rounded-lg object-cover border border-border" />
              <button onClick={() => removeImage(i)} className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {canAddMore && (
            <button onClick={() => fileInputRef.current?.click()} className="flex h-14 w-14 sm:h-20 sm:w-20 flex-shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-border text-muted-foreground hover:border-ring/50 hover:text-foreground transition-colors">
              <Plus className="h-5 w-5" />
            </button>
          )}
        </div>
      )}

      {deepSearchMode && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-1.5 text-sm text-primary">
          <Search className="h-4 w-4 flex-shrink-0" />
          <span className="truncate">Режим глубокого поиска</span>
          <button onClick={() => setDeepSearchMode(false)} className="ml-auto flex-shrink-0"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {isListening && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-destructive/10 px-3 py-1.5 text-sm text-destructive">
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
          </span>
          <span className="truncate text-xs sm:text-sm">Слушаю... (нажмите ещё раз, чтобы остановить)</span>
        </div>
      )}

      {isProcessing && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-muted px-3 py-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" />
          <span className="text-xs sm:text-sm">Распознаю речь...</span>
        </div>
      )}

      <div className="relative flex items-end rounded-2xl border border-border bg-secondary/50 shadow-sm transition-all duration-200 focus-within:border-ring/50 focus-within:shadow-md">
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileSelect} />

        {/* Left buttons */}
        <div className="flex items-center pl-0.5 sm:pl-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 rounded-lg p-2 sm:p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground active:scale-90 transition-all"
            title="Прикрепить изображения"
          >
            <Image style={{ width: "18px", height: "18px" }} />
          </button>


          {deepSearchEnabled && (
            <button
              onClick={() => !deepSearchUsed && setDeepSearchMode(!deepSearchMode)}
              disabled={deepSearchUsed}
              className={`flex-shrink-0 rounded-lg p-2 sm:p-2.5 transition-all active:scale-90 ${
                deepSearchUsed ? "text-muted-foreground/30 cursor-not-allowed"
                : deepSearchMode ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              title={deepSearchUsed ? "Лимит глубокого поиска исчерпан" : "Глубокий поиск"}
            >
              <Search style={{ width: "18px", height: "18px" }} />
            </button>
          )}

          {voiceSupported && (
            <button
              onClick={toggleVoice}
              disabled={isProcessing}
              className={`flex-shrink-0 rounded-lg p-2 sm:p-2.5 transition-all active:scale-90 ${
                isListening ? "text-destructive bg-destructive/10"
                : isProcessing ? "text-muted-foreground/40 cursor-not-allowed"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              title={isListening ? "Остановить запись" : isProcessing ? "Обработка..." : "Голосовой ввод"}
            >
              {isProcessing ? <Loader2 style={{ width: "18px", height: "18px" }} className="animate-spin" />
                : isListening ? <MicOff style={{ width: "18px", height: "18px" }} />
                : <Mic style={{ width: "18px", height: "18px" }} />
              }
            </button>
          )}
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isListening ? "Говорите..." : deepSearchMode ? "Введите запрос для поиска..." : "Напишите сообщение..."}
          rows={1}
          className="flex-1 resize-none bg-transparent py-3 pr-1 text-sm sm:text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />

        <button
          onClick={handleSubmit}
          disabled={!isStreaming && !value.trim() && imagePreviews.length === 0}
          className={`m-1.5 sm:m-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-all active:scale-90 ${
            isStreaming ? "bg-foreground text-background"
            : value.trim() || imagePreviews.length > 0 ? "bg-foreground text-background hover:opacity-80"
            : "bg-muted text-muted-foreground cursor-not-allowed"
          }`}
        >
          {isStreaming ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>

      <p className="mt-1.5 sm:mt-2 text-center text-[11px] sm:text-xs text-muted-foreground">
        HikkoGPT может допускать ошибки. Проверяйте важную информацию.
      </p>

    </div>
  );
}
