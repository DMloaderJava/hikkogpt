import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ArrowUp, Square, X, Image, Search, Mic, MicOff, Loader2, Plus, AudioLines, Camera, Volume2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { useVoice } from "@/hooks/useVoice";
import { DialogTtsModal } from "@/components/DialogTtsModal";
import { CameraBottomSheet } from "@/components/CameraBottomSheet";
import { PlusMenu } from "@/components/PlusMenu";
import type { PlusMenuItem } from "@/components/PlusMenu";
import {
  MAX_IMAGES_PER_MESSAGE,
  blobToDataURL,
  createImageAttachment,
  createImageAttachmentFromPhoto,
  isCameraLimitBypassed,
  revokeImageAttachment,
} from "@/lib/imageAttachments";
import type { CapturedPhoto, ImageAttachment } from "@/lib/imageAttachments";
import type { ConnectionStatus } from "@/types/gemini-live";

interface ChatInputProps {
  onSend: (message: string, images?: string[]) => void;
  isStreaming: boolean;
  onStop: () => void;
  deepSearchEnabled?: boolean;
  deepSearchUsed?: boolean;
  onDeepSearch?: (query: string) => void;
  /** Голосовой режим Gemini Live: статус и переключатель (кнопка AudioLines). */
  voiceModeStatus?: ConnectionStatus;
  onToggleVoiceMode?: () => void;
  /** E-mail текущего пользователя — для исключений из лимита вложений. */
  userEmail?: string | null;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function ChatInput({ onSend, isStreaming, onStop, deepSearchEnabled = true, deepSearchUsed = false, onDeepSearch, voiceModeStatus, onToggleVoiceMode, userEmail }: ChatInputProps) {
  const [value, setValue] = useState("");
  // Лёгкие Blob-превью (object URL), НЕ base64 — иначе ввод лагает.
  const [imagePreviews, setImagePreviews] = useState<ImageAttachment[]>([]);
  const [deepSearchMode, setDeepSearchMode] = useState(false);
  const [ttsOpen, setTtsOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { state: voiceState, supported: voiceSupported, toggle: toggleVoice } = useVoice({
    onTranscript: (text) => {
      setValue((prev) => prev ? `${prev} ${text}` : text);
      textareaRef.current?.focus();
    },
  });

  // Лимит вложений + исключение для привилегированных e-mail.
  const limitBypassed = isCameraLimitBypassed(userEmail);
  const atImageLimit = !limitBypassed && imagePreviews.length >= MAX_IMAGES_PER_MESSAGE;
  const canAddMore = limitBypassed || imagePreviews.length < MAX_IMAGES_PER_MESSAGE;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
    }
  }, [value]);

  // Отзываем object URL при размонтировании (страховка от утечек).
  const previewsRef = useRef(imagePreviews);
  previewsRef.current = imagePreviews;
  useEffect(() => {
    return () => {
      previewsRef.current.forEach(revokeImageAttachment);
    };
  }, []);

  const clearPreviews = useCallback(() => {
    setImagePreviews((prev) => {
      prev.forEach(revokeImageAttachment);
      return [];
    });
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!files.length) return;
    const validFiles = files.filter(f => f.type.startsWith("image/") && f.size <= MAX_FILE_SIZE);
    if (validFiles.length < files.length) {
      toast.warning("Некоторые файлы пропущены: нужны изображения до 10 МБ");
    }
    const room = limitBypassed ? validFiles.length : Math.max(0, MAX_IMAGES_PER_MESSAGE - imagePreviews.length);
    const toProcess = validFiles.slice(0, room);
    if (toProcess.length < validFiles.length) {
      toast.warning(`Достигнут лимит: максимум ${MAX_IMAGES_PER_MESSAGE} фото`);
    }
    if (!toProcess.length) return;
    setImagePreviews((prev) => [...prev, ...toProcess.map((file) => createImageAttachment(file))]);
  };

  const removeImage = (id: string) => {
    setImagePreviews((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) revokeImageAttachment(target);
      return prev.filter((a) => a.id !== id);
    });
  };

  const handleSubmit = () => {
    void submitAsync();
  };

  const submitAsync = async () => {
    if (isStreaming) { onStop(); return; }
    if (isPreparingImages) return;
    if (!value.trim() && imagePreviews.length === 0) return;
    if (deepSearchMode && onDeepSearch) {
      onDeepSearch(value.trim());
      setValue("");
      setDeepSearchMode(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      return;
    }
    const text = value.trim() || (imagePreviews.length > 0 ? "Что на этих изображениях?" : "");
    if (imagePreviews.length > 0) {
      // Единственное место, где Blob превращаются в base64 — момент отправки.
      setIsPreparingImages(true);
      try {
        const dataUrls = await Promise.all(imagePreviews.map((a) => blobToDataURL(a.blob)));
        onSend(text, dataUrls);
      } catch {
        toast.error("Не удалось подготовить изображения к отправке");
        setIsPreparingImages(false);
        return;
      }
      setIsPreparingImages(false);
    } else {
      onSend(text);
    }
    setValue("");
    clearPreviews();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleCameraCapture = useCallback((photo: CapturedPhoto) => {
    // Safety net: кнопка уже задизейблена у лимита, но перестрахуемся.
    // ВАЖНО: чужой object URL либо забираем в стейт, либо отзываем сразу.
    if (!limitBypassed && imagePreviews.length >= MAX_IMAGES_PER_MESSAGE) {
      revokeImageAttachment(photo);
      toast.warning(`Достигнут лимит: максимум ${MAX_IMAGES_PER_MESSAGE} фото`);
      return;
    }
    setImagePreviews((prev) => [...prev, createImageAttachmentFromPhoto(photo)]);
  }, [imagePreviews.length, limitBypassed]);

  const isListening = voiceState === "listening";
  const isProcessing = voiceState === "processing";
  const isVoiceModeActive = voiceModeStatus === "connected" || voiceModeStatus === "connecting";
  const limitTitle = `Достигнут лимит: максимум ${MAX_IMAGES_PER_MESSAGE} фото`;

  // Редкие действия прячем под «+», в строке остаются камера, голос и диктовка.
  const plusMenuItems = useMemo<PlusMenuItem[]>(() => {
    const items: PlusMenuItem[] = [
      {
        id: "attach",
        label: "Прикрепить изображения",
        description: `Из галереи, до ${MAX_IMAGES_PER_MESSAGE} фото`,
        icon: Image,
        disabled: atImageLimit,
        disabledReason: limitTitle,
        onSelect: () => fileInputRef.current?.click(),
      },
    ];

    if (deepSearchEnabled) {
      items.push({
        id: "deep-search",
        label: "Глубокий поиск",
        description: "Разбор темы по источникам из интернета",
        icon: Search,
        disabled: deepSearchUsed,
        disabledReason: "Лимит глубокого поиска исчерпан",
        active: deepSearchMode,
        onSelect: () => setDeepSearchMode((prev) => !prev),
      });
    }

    items.push({
      id: "tts",
      label: "Озвучка диалога",
      description: "Озвучить реплики разными голосами",
      icon: Volume2,
      onSelect: () => setTtsOpen(true),
    });

    return items;
  }, [atImageLimit, limitTitle, deepSearchEnabled, deepSearchUsed, deepSearchMode]);

  return (
    <div className="mx-auto w-full max-w-3xl px-2 sm:px-4 pb-2 sm:pb-4" style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom, 8px))" }}>
      {/* Image previews */}
      {imagePreviews.length > 0 && (
        <div className="mb-2 flex items-start gap-1.5 flex-wrap animate-fade-in-up">
          {imagePreviews.map((attachment, i) => (
            <div key={attachment.id} className="relative flex-shrink-0 animate-pop">
              <img src={attachment.url} alt={`Preview ${i + 1}`} className="h-14 w-14 sm:h-20 sm:w-20 rounded-lg object-cover border border-border" />
              <button onClick={() => removeImage(attachment.id)} aria-label={`Убрать фото ${i + 1}`} className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs transition-transform active:scale-75">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {canAddMore && (
            <button onClick={() => fileInputRef.current?.click()} aria-label="Добавить ещё фото" className="flex h-14 w-14 sm:h-20 sm:w-20 flex-shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-border text-muted-foreground btn-interactive transition-all">
              <Plus className="h-5 w-5" />
            </button>
          )}
        </div>
      )}

      {deepSearchMode && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-interactive/10 px-3 py-1.5 text-sm text-interactive animate-slide-up">
          <Search className="h-4 w-4 flex-shrink-0" />
          <span className="truncate">Режим глубокого поиска</span>
          <button onClick={() => setDeepSearchMode(false)} className="ml-auto flex-shrink-0 btn-interactive rounded-full p-0.5"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {isListening && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-destructive/10 px-3 py-1.5 text-sm text-destructive animate-slide-up">
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
          </span>
          <span className="truncate text-xs sm:text-sm">Слушаю... (нажмите ещё раз, чтобы остановить)</span>
        </div>
      )}

      {isProcessing && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-muted px-3 py-1.5 text-sm text-muted-foreground animate-slide-up">
          <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" />
          <span className="text-xs sm:text-sm">Распознаю речь...</span>
        </div>
      )}

      <div className="relative flex items-end rounded-2xl border border-border bg-secondary/50 shadow-sm transition-all duration-200 focus-within:border-interactive/40 focus-within:shadow-md focus-within:shadow-interactive/5">
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileSelect} data-testid="chat-file-input" />

        {/* Left buttons: частое — в строке, остальное — под «+» */}
        <div className="flex items-center pl-0.5 sm:pl-1">
          <PlusMenu items={plusMenuItems} />

          <button
            onClick={() => setCameraOpen(true)}
            disabled={atImageLimit}
            className={`flex-shrink-0 rounded-lg p-2 sm:p-2.5 transition-all ${
              atImageLimit ? "text-muted-foreground/30 cursor-not-allowed" : "btn-interactive text-muted-foreground"
            }`}
            title={atImageLimit ? limitTitle : "Камера — сделать фото"}
            aria-label={atImageLimit ? limitTitle : "Сделать фото"}
          >
            <Camera style={{ width: "18px", height: "18px" }} />
          </button>

          {onToggleVoiceMode && (
            <button
              onClick={onToggleVoiceMode}
              className={`relative flex-shrink-0 rounded-lg p-2 sm:p-2.5 transition-all ${
                isVoiceModeActive ? "text-interactive bg-interactive/10"
                : "btn-interactive text-muted-foreground"
              }`}
              title={isVoiceModeActive ? "Открыть голосовой режим" : "Голосовой режим Gemini Live"}
            >
              <AudioLines style={{ width: "18px", height: "18px" }} />
              {isVoiceModeActive && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-interactive animate-pulse" />
              )}
            </button>
          )}

          {/* Диктовка (распознать текст) — отдельный от голосового режима путь */}
          {voiceSupported && (
            <button
              onClick={toggleVoice}
              disabled={isProcessing}
              className={`flex-shrink-0 rounded-lg p-2 sm:p-2.5 transition-all ${
                isListening ? "text-destructive bg-destructive/10"
                : isProcessing ? "text-muted-foreground/40 cursor-not-allowed"
                : "btn-interactive text-muted-foreground"
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
          disabled={(!isStreaming && !value.trim() && imagePreviews.length === 0) || isPreparingImages}
          aria-label={isStreaming ? "Остановить" : "Отправить"}
          className={`m-1.5 sm:m-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-all active:scale-90 ${
            isStreaming ? "bg-foreground text-background"
            : value.trim() || imagePreviews.length > 0 ? "bg-interactive text-interactive-foreground hover:opacity-90 shadow-sm shadow-interactive/20"
            : "bg-muted text-muted-foreground cursor-not-allowed"
          }`}
        >
          {isStreaming ? <Square className="h-3.5 w-3.5" fill="currentColor" />
            : isPreparingImages ? <Loader2 className="h-4 w-4 animate-spin" />
            : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>

      <DialogTtsModal open={ttsOpen} onClose={() => setTtsOpen(false)} />

      <CameraBottomSheet
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onCapture={handleCameraCapture}
      />

      <p className="mt-1.5 sm:mt-2 text-center text-[11px] sm:text-xs text-muted-foreground">
        HikkoGPT может допускать ошибки. Проверяйте важную информацию.
      </p>
    </div>
  );
}
