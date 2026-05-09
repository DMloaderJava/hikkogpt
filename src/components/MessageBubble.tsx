import { Copy, ThumbsUp, ThumbsDown, RotateCcw, Volume2, VolumeX, Pencil, Sparkles, ChevronDown, ChevronRight, Brain } from "lucide-react";
import { useState, useRef, useCallback } from "react";
import type { Message } from "@/hooks/useChat";
import { getEdgeAuthHeaders } from "@/lib/edgeAuth";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

type VoiceState = "idle" | "loading" | "playing";

function useTTS() {
  const [state, setState] = useState<VoiceState>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stateRef = useRef<VoiceState>("idle");

  const setS = (s: VoiceState) => { stateRef.current = s; setState(s); };

  const speak = useCallback(async (text: string, voice = "Aoede") => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    const clean = text
      .replace(/```[\s\S]*?```/g, "код")
      .replace(/`[^`]+`/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/#{1,3}\s/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/---/g, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .trim();

    if (!clean) return;

    setS("loading");

    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/gemini-tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getEdgeAuthHeaders()) },
        body: JSON.stringify({ text: clean, voice }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error("TTS error:", err.error || resp.status);
        setS("idle");
        return;
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onplay = () => setS("playing");
      audio.onended = () => { URL.revokeObjectURL(url); audioRef.current = null; setS("idle"); };
      audio.onerror = () => { URL.revokeObjectURL(url); audioRef.current = null; setS("idle"); };

      await audio.play();
    } catch (e) {
      console.error("TTS fetch error:", e);
      setS("idle");
    }
  }, []);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setS("idle");
  }, []);

  return { state, speak, stop };
}

function ImageGrid({ images }: { images: string[] }) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  if (images.length === 0) return null;

  const visibleImages = images.slice(0, 4);
  const extra = images.length > 4 ? images.length - 4 : 0;
  const gridClass = images.length === 1 ? "grid grid-cols-1" : "grid grid-cols-2 gap-1";

  return (
    <>
      <div className={`${gridClass} rounded-xl overflow-hidden max-w-xs sm:max-w-sm animate-fade-in-up`}>
        {visibleImages.map((src, i) => (
          <div
            key={i}
            className={`relative overflow-hidden ${images.length === 3 && i === 2 ? "col-span-2" : ""}`}
            style={{ aspectRatio: images.length === 1 ? "auto" : "1/1" }}
          >
            <img
              src={src}
              alt={`Attached ${i + 1}`}
              className={`w-full h-full object-cover cursor-pointer hover:opacity-90 hover:scale-[1.02] transition-all duration-200 ${images.length === 1 ? "max-h-64 object-contain" : ""}`}
              onClick={() => setLightbox(src)}
              loading="lazy"
            />
            {i === 3 && extra > 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
                <span className="text-xl font-bold text-foreground">+{extra}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="Full" className="max-w-full max-h-full rounded-xl object-contain shadow-2xl animate-scale-in" />
          <button
            className="absolute right-4 top-4 rounded-full bg-secondary p-2 text-foreground btn-interactive transition-all"
            onClick={() => setLightbox(null)}
          >✕</button>
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

function extractInlineImages(content: string): { text: string; images: { src: string; alt: string }[] } {
  const images: { src: string; alt: string }[] = [];
  const withoutSources = content
    .replace(/\n*---\n+\*\*Источники:\*\*[\s\S]*$/m, "")
    .replace(/\n*---\n+\*\*Sources:\*\*[\s\S]*$/m, "");

  const text = withoutSources.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    images.push({ src, alt });
    return "";
  });

  const cleanText = text.replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleanText, images };
}

function parseInline(text: string): React.ReactNode[] {
  const regex = /(\*\*\*(.*?)\*\*\*|\*\*(.*?)\*\*|\*(.*?)\*|~~(.*?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let ki = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      nodes.push(<strong key={ki}><em>{match[2]}</em></strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<strong key={ki}>{match[3]}</strong>);
    } else if (match[4] !== undefined) {
      nodes.push(<em key={ki}>{match[4]}</em>);
    } else if (match[5] !== undefined) {
      nodes.push(<del key={ki} className="text-muted-foreground">{match[5]}</del>);
    } else if (match[6] !== undefined) {
      nodes.push(
        <code key={ki} className="rounded bg-code-block px-1.5 py-0.5 text-xs sm:text-sm text-code-block-foreground">
          {match[6]}
        </code>
      );
    } else if (match[7] !== undefined && match[8] !== undefined) {
      nodes.push(match[7]);
    }
    ki++;
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

function renderTable(tableLines: string[], startKey: number): { node: React.ReactNode; key: number } {
  let key = startKey;
  const headerCells = tableLines[0].split("|").map(c => c.trim()).filter(Boolean);
  const bodyRows = tableLines.slice(2);

  return {
    node: (
      <div key={key++} className="my-3 overflow-x-auto rounded-lg border border-border animate-fade-in-up">
        <table className="w-full text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              {headerCells.map((cell, i) => (
                <th key={i} className="px-3 py-2 text-left font-semibold text-foreground whitespace-nowrap">
                  {parseInline(cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => {
              const cells = row.split("|").map(c => c.trim()).filter(Boolean);
              return (
                <tr key={ri} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                  {cells.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 text-foreground">
                      {parseInline(cell)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ),
    key,
  };
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
      <div key={key++} className="my-3 rounded-lg overflow-hidden animate-fade-in-up">
        <div className="flex items-center justify-between bg-code-block-header px-3 sm:px-4 py-2 text-xs text-code-block-foreground">
          <span>{codeLang || "code"}</span>
          <button
            onClick={() => navigator.clipboard.writeText(code)}
            className="flex items-center gap-1 btn-interactive rounded px-1.5 py-0.5 transition-all"
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

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCodeBlock) { flushCode(); inCodeBlock = false; }
      else { inCodeBlock = true; codeLang = line.slice(3).trim(); }
      i++;
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); i++; continue; }

    if (/^!\[[^\]]*\]\([^)]+\)$/.test(line.trim())) { i++; continue; }

    if (line.includes("|") && i + 1 < lines.length && /^\|?\s*[-:]+[-|\s:]*$/.test(lines[i + 1])) {
      const tableLines: string[] = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        tableLines.push(lines[j]);
        j++;
      }
      const result = renderTable(tableLines, key);
      parts.push(result.node);
      key = result.key;
      i = j;
      continue;
    }

    if (line.startsWith("### ")) {
      parts.push(<h3 key={key++} className="mt-4 mb-1.5 text-sm sm:text-base font-semibold text-foreground">{parseInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      parts.push(<h2 key={key++} className="mt-4 sm:mt-5 mb-1.5 sm:mb-2 text-base sm:text-lg font-bold text-foreground">{parseInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      parts.push(<h1 key={key++} className="mt-4 sm:mt-5 mb-1.5 sm:mb-2 text-lg sm:text-xl font-bold text-foreground">{parseInline(line.slice(2))}</h1>);
    }
    else if (line.startsWith("- ") || line.startsWith("* ")) {
      parts.push(<li key={key++} className="ml-4 sm:ml-5 list-disc leading-relaxed text-sm sm:text-[15px]">{parseInline(line.slice(2))}</li>);
    }
    else if (/^\d+\.\s/.test(line)) {
      parts.push(<li key={key++} className="ml-4 sm:ml-5 list-decimal leading-relaxed text-sm sm:text-[15px]">{parseInline(line.replace(/^\d+\.\s/, ""))}</li>);
    }
    else if (line.startsWith("> ")) {
      parts.push(<blockquote key={key++} className="my-2 border-l-2 border-muted-foreground/40 pl-3 sm:pl-4 italic text-muted-foreground text-xs sm:text-sm">{parseInline(line.slice(2))}</blockquote>);
    }
    else if (line === "---" || line === "***") {
      parts.push(<hr key={key++} className="my-3 border-border" />);
    }
    else if (line === "") {
      parts.push(<br key={key++} />);
    }
    else {
      parts.push(<p key={key++} className="my-0.5 leading-relaxed text-sm sm:text-[15px]">{parseInline(line)}</p>);
    }

    i++;
  }

  if (inCodeBlock) flushCode();
  return parts;
}

export function MessageBubble({ message, isStreaming, ttsVoice = "Aoede" }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [liked, setLiked] = useState<boolean | null>(null);
  const isUser = message.role === "user";

  const { state: ttsState, speak, stop: stopSpeaking } = useTTS();
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

  const userImages = message.images || (message.image_url ? [message.image_url] : []);

  const { text: cleanContent, images: inlineImages } = !isUser
    ? extractInlineImages(message.content)
    : { text: message.content, images: [] };

  const displayContent = isUser ? message.content : cleanContent;

  return (
    <div className={`animate-fade-in-up py-2 sm:py-3 ${isUser ? "flex justify-end" : ""}`}>
      <div className={`flex gap-2 sm:gap-3 ${isUser ? "flex-row-reverse max-w-[88%] sm:max-w-[75%]" : "max-w-full"}`}>
        {/* Avatar */}
        {!isUser && (
          <div className="flex h-6 w-6 sm:h-7 sm:w-7 flex-shrink-0 items-center justify-center rounded-full bg-interactive text-interactive-foreground mt-0.5 animate-pop">
            <Sparkles className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
          </div>
        )}

        <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
          {/* User-attached images */}
          {isUser && userImages.length > 0 && (
            <div className="mb-2 flex justify-end">
              <ImageGrid images={userImages} />
            </div>
          )}

          {/* Thinking block */}
          {!isUser && message.thinking && (
            <div className="mb-2 sm:mb-3">
              <button
                onClick={() => setThinkingOpen(!thinkingOpen)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground btn-interactive rounded-lg px-2 py-1 transition-all"
              >
                <Brain className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                <span>Размышления</span>
                {thinkingOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              {thinkingOpen && (
                <div className="mt-2 rounded-xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed animate-slide-up">
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
                    <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-interactive animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-interactive animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-interactive animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              ) : (
                <>
                  {renderContent(displayContent)}
                  {isStreaming && !isUser && (
                    <span className="inline-block w-1.5 h-4 sm:h-5 bg-interactive ml-0.5 animate-blink rounded-sm" />
                  )}
                </>
              )}
            </div>
          </div>

          {/* Inline images */}
          {!isUser && inlineImages.length > 0 && !isStreaming && (
            <div className="mt-3">
              <ImageGrid images={inlineImages.map(i => i.src)} />
            </div>
          )}

          {/* Action bar */}
          {!isUser && !isStreaming && message.content && (
            <div className="mt-1 sm:mt-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all duration-200">
              <button onClick={handleCopy} className="btn-interactive rounded-lg p-1.5 text-muted-foreground transition-all" title={copied ? "Скопировано!" : "Копировать"}>
                <Copy className={`h-3.5 w-3.5 ${copied ? "text-interactive" : ""}`} />
              </button>
              <button
                onClick={handleSpeak}
                className={`rounded-lg p-1.5 transition-all ${isSpeaking ? "text-interactive bg-interactive/10" : "btn-interactive text-muted-foreground"}`}
                title={isSpeaking ? "Остановить" : "Озвучить"}
              >
                {ttsState === "loading" ? (
                  <span className="h-3.5 w-3.5 flex items-center justify-center">
                    <span className="h-2 w-2 rounded-full bg-interactive animate-pulse" />
                  </span>
                ) : isSpeaking ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => setLiked(liked === true ? null : true)} className={`rounded-lg p-1.5 transition-all ${liked === true ? "text-interactive bg-interactive/10" : "btn-interactive text-muted-foreground"}`} title="Хороший ответ">
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setLiked(liked === false ? null : false)} className={`rounded-lg p-1.5 transition-all ${liked === false ? "text-destructive bg-destructive/10" : "btn-interactive text-muted-foreground"}`} title="Плохой ответ">
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
              <button className="btn-interactive rounded-lg p-1.5 text-muted-foreground transition-all" title="Перегенерировать">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Edit for user messages */}
          {isUser && !isStreaming && (
            <div className="mt-1 flex justify-end">
              <button className="btn-interactive rounded-lg p-1 text-muted-foreground transition-all opacity-0 hover:opacity-100" title="Редактировать">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
