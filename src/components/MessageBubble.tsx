import { Copy, ThumbsUp, ThumbsDown, RotateCcw, Volume2, VolumeX, Pencil, Sparkles, ChevronDown, ChevronRight, Brain } from "lucide-react";
import { useState, useRef, useCallback } from "react";
import type { Message } from "@/hooks/useChat";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type VoiceState = "idle" | "loading" | "playing";

function useGeminiTTS() {
  const [state, setState] = useState<VoiceState>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const speak = useCallback(async (text: string, voice = "Aoede") => {
    const clean = text
      .replace(/```[\s\S]*?```/g, "код")
      .replace(/`[^`]+`/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/#{1,3}\s/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/---/g, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .trim();
    if (!clean) return;

    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setState("loading");
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/gemini-tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ text: clean.slice(0, 4000), voice, language: "ru-RU" }),
      });
      if (!resp.ok) { setState("idle"); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onplay = () => setState("playing");
      audio.onended = () => { setState("idle"); URL.revokeObjectURL(url); };
      audio.onerror = () => { setState("idle"); URL.revokeObjectURL(url); };
      audio.play();
    } catch { setState("idle"); }
  }, []);

  const stop = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setState("idle");
  }, []);

  return { state, speak, stop };
}

// Image grid: 1 → full width, 2 → side by side, 3 → 2+1, 4+ → 2×2 grid
function ImageGrid({ images }: { images: string[] }) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  if (images.length === 0) return null;

  const gridClass =
    images.length === 1
      ? "grid grid-cols-1"
      : images.length === 2
      ? "grid grid-cols-2 gap-1"
      : "grid grid-cols-2 gap-1";

  const visibleImages = images.slice(0, 4);
  const extra = images.length > 4 ? images.length - 4 : 0;

  return (
    <>
      <div className={`mb-2 ${gridClass} rounded-xl overflow-hidden max-w-xs sm:max-w-sm`}>
        {visibleImages.map((src, i) => (
          <div
            key={i}
            className={`relative overflow-hidden ${images.length === 3 && i === 2 ? "col-span-2" : ""}`}
            style={{ aspectRatio: images.length === 1 ? "auto" : "1/1" }}
          >
            <img
              src={src}
              alt={`Attached ${i + 1}`}
              className={`w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity ${
                images.length === 1 ? "max-h-64 object-contain" : ""
              }`}
              onClick={() => setLightbox(src)}
            />
            {i === 3 && extra > 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
                <span className="text-xl font-bold text-foreground">+{extra}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm p-4"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="Full" className="max-w-full max-h-full rounded-xl object-contain shadow-2xl" />
          <button
            className="absolute right-4 top-4 rounded-full bg-secondary p-2 text-foreground"
            onClick={() => setLightbox(null)}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  ttsVoice?: string;
}

function renderContent(content: string) {
  const parts: React.ReactNode[] = [];
  const lines = content.split("\n");
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = "";
  let key = 0;

  const flushCode = () => {
    const code = codeLines.join("\n");
    parts.push(
      <div key={key++} className="my-3 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between bg-code-block-header px-3 sm:px-4 py-2 text-xs text-code-block-foreground">
          <span>{codeLang || "code"}</span>
          <button
            onClick={() => navigator.clipboard.writeText(code)}
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
        </div>
        <pre className="bg-code-block p-3 sm:p-4 overflow-x-auto text-xs sm:text-sm">
          <code className="text-code-block-foreground">{code}</code>
        </pre>
      </div>
    );
    codeLines = [];
    codeLang = "";
  };

  lines.forEach((line) => {
    if (line.startsWith("```")) {
      if (inCodeBlock) { flushCode(); inCodeBlock = false; }
      else { inCodeBlock = true; codeLang = line.slice(3).trim(); }
      return;
    }
    if (inCodeBlock) { codeLines.push(line); return; }

    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      parts.push(<img key={key++} src={imgMatch[2]} alt={imgMatch[1]} className="my-3 max-w-full rounded-lg" loading="lazy" />);
      return;
    }

    let processed: React.ReactNode = line;

    if (line.includes("**")) {
      const segs = line.split(/\*\*(.*?)\*\*/g);
      processed = segs.map((s, i) => i % 2 === 1 ? <strong key={i}>{s}</strong> : s);
    }

    if (typeof processed === "string" && processed.includes("`")) {
      const segs = processed.split(/`([^`]+)`/g);
      processed = segs.map((s, i) =>
        i % 2 === 1 ? <code key={i} className="rounded bg-code-block px-1.5 py-0.5 text-xs sm:text-sm text-code-block-foreground">{s}</code> : s
      );
    }

    if (typeof processed === "string" && processed.includes("](")) {
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      const segments: React.ReactNode[] = [];
      let lastIndex = 0;
      let match;
      while ((match = linkRegex.exec(processed)) !== null) {
        if (match.index > lastIndex) segments.push(processed.slice(lastIndex, match.index));
        segments.push(<a key={match.index} href={match[2]} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80 transition-opacity break-all">{match[1]}</a>);
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < processed.length) segments.push(processed.slice(lastIndex));
      processed = segments;
    }

    if (line.startsWith("### ")) parts.push(<h3 key={key++} className="mt-4 mb-1.5 text-sm sm:text-base font-semibold text-foreground">{line.slice(4)}</h3>);
    else if (line.startsWith("## ")) parts.push(<h2 key={key++} className="mt-4 sm:mt-5 mb-1.5 sm:mb-2 text-base sm:text-lg font-bold text-foreground">{line.slice(3)}</h2>);
    else if (line.startsWith("# ")) parts.push(<h1 key={key++} className="mt-4 sm:mt-5 mb-1.5 sm:mb-2 text-lg sm:text-xl font-bold text-foreground">{line.slice(2)}</h1>);
    else if (line.startsWith("- ") || line.startsWith("* ")) parts.push(<li key={key++} className="ml-4 sm:ml-5 list-disc leading-relaxed text-sm sm:text-[15px]">{typeof processed === "string" ? line.slice(2) : <>{Array.isArray(processed) ? processed : line.slice(2)}</>}</li>);
    else if (/^\d+\.\s/.test(line)) parts.push(<li key={key++} className="ml-4 sm:ml-5 list-decimal leading-relaxed text-sm sm:text-[15px]">{typeof processed === "string" ? line.replace(/^\d+\.\s/, "") : processed}</li>);
    else if (line.startsWith("> ")) parts.push(<blockquote key={key++} className="my-2 border-l-2 border-muted-foreground/40 pl-3 sm:pl-4 italic text-muted-foreground text-xs sm:text-sm">{line.slice(2)}</blockquote>);
    else if (line === "---" || line === "***") parts.push(<hr key={key++} className="my-3 border-border" />);
    else if (line === "") parts.push(<br key={key++} />);
    else parts.push(<p key={key++} className="my-0.5 leading-relaxed text-sm sm:text-[15px]">{processed}</p>);
  });

  if (inCodeBlock) flushCode();
  return parts;
}

export function MessageBubble({ message, isStreaming, ttsVoice = "Aoede" }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [liked, setLiked] = useState<boolean | null>(null);
  const isUser = message.role === "user";

  const { state: ttsState, speak, stop: stopSpeaking } = useGeminiTTS();
  const isSpeaking = ttsState === "playing" || ttsState === "loading";

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  const handleSpeak = useCallback(() => {
    if (isSpeaking) stopSpeaking();
    else speak(message.content, ttsVoice);
  }, [isSpeaking, speak, stopSpeaking, message.content, ttsVoice]);

  const allImages = message.images || (message.image_url ? [message.image_url] : []);

  return (
    <div className={`animate-fade-in-up py-2 sm:py-3 ${isUser ? "flex justify-end" : ""}`}>
      <div className={`flex gap-2 sm:gap-3 ${isUser ? "flex-row-reverse max-w-[88%] sm:max-w-[75%]" : "max-w-full"}`}>
        {/* Avatar */}
        {!isUser && (
          <div className="flex h-6 w-6 sm:h-7 sm:w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground mt-0.5">
            <Sparkles className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
          </div>
        )}

        <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
          {/* Image grid for user */}
          {isUser && allImages.length > 0 && (
            <div className="mb-2 flex justify-end">
              <ImageGrid images={allImages} />
            </div>
          )}

          {/* Thinking block */}
          {!isUser && message.thinking && (
            <div className="mb-2 sm:mb-3">
              <button
                onClick={() => setThinkingOpen(!thinkingOpen)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Brain className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                <span>Размышления</span>
                {thinkingOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              {thinkingOpen && (
                <div className="mt-2 rounded-xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {message.thinking}
                </div>
              )}
            </div>
          )}

          <div className={isUser
            ? "inline-block rounded-2xl rounded-tr-sm bg-user-bubble px-3 sm:px-4 py-2 sm:py-2.5 text-left text-user-bubble-foreground shadow-sm"
            : "text-foreground"
          }>
            <div className="text-sm sm:text-[15px] leading-relaxed break-words">
              {isStreaming && !isUser && !message.content ? (
                <div className="flex items-center gap-2 text-muted-foreground py-1">
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              ) : (
                <>
                  {renderContent(message.content)}
                  {isStreaming && !isUser && (
                    <span className="inline-block w-1.5 h-4 sm:h-5 bg-foreground ml-0.5 animate-blink" />
                  )}
                </>
              )}
            </div>
          </div>

          {/* Action bar for assistant messages */}
          {!isUser && !isStreaming && message.content && (
            <div className="mt-1 sm:mt-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={handleCopy} className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors active:scale-90" title={copied ? "Скопировано!" : "Копировать"}>
                <Copy className={`h-3.5 w-3.5 ${copied ? "text-primary" : ""}`} />
              </button>
              <button
                onClick={handleSpeak}
                className={`rounded-lg p-1.5 transition-colors active:scale-90 ${isSpeaking ? "text-primary bg-primary/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
                title={isSpeaking ? "Остановить" : "Озвучить"}
              >
                {ttsState === "loading" ? (
                  <span className="h-3.5 w-3.5 flex items-center justify-center">
                    <span className="h-2 w-2 rounded-full bg-current animate-pulse" />
                  </span>
                ) : isSpeaking ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => setLiked(liked === true ? null : true)} className={`rounded-lg p-1.5 transition-colors active:scale-90 ${liked === true ? "text-primary bg-primary/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`} title="Хороший ответ">
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setLiked(liked === false ? null : false)} className={`rounded-lg p-1.5 transition-colors active:scale-90 ${liked === false ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`} title="Плохой ответ">
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
              <button className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors active:scale-90" title="Перегенерировать">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Edit for user messages */}
          {isUser && !isStreaming && (
            <div className="mt-1 flex justify-end">
              <button className="rounded-lg p-1 text-muted-foreground hover:text-foreground transition-colors opacity-0 hover:opacity-100 active:scale-90" title="Редактировать">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
