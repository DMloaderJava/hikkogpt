import { Copy, ThumbsUp, ThumbsDown, RotateCcw, Volume2, VolumeX, Pencil, Sparkles, ChevronDown, ChevronRight, Brain } from "lucide-react";
import { useState, useCallback } from "react";
import type { Message } from "@/hooks/useChat";
import { useVoice } from "@/hooks/useVoice";

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
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
        <div className="flex items-center justify-between bg-code-block-header px-4 py-2 text-xs text-code-block-foreground">
          <span>{codeLang || "code"}</span>
          <button
            onClick={() => navigator.clipboard.writeText(code)}
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy code
          </button>
        </div>
        <pre className="bg-code-block p-4 overflow-x-auto text-sm">
          <code className="text-code-block-foreground">{code}</code>
        </pre>
      </div>
    );
    codeLines = [];
    codeLang = "";
  };

  lines.forEach((line) => {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      return;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }

    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      parts.push(
        <img key={key++} src={imgMatch[2]} alt={imgMatch[1]} className="my-3 max-w-full rounded-lg" loading="lazy" />
      );
      return;
    }

    let processed: React.ReactNode = line;

    if (line.includes("**")) {
      const segments = line.split(/\*\*(.*?)\*\*/g);
      processed = segments.map((seg, i) =>
        i % 2 === 1 ? <strong key={i}>{seg}</strong> : seg
      );
    }

    if (typeof processed === "string" && processed.includes("`")) {
      const segments = processed.split(/`([^`]+)`/g);
      processed = segments.map((seg, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-code-block px-1.5 py-0.5 text-sm text-code-block-foreground">
            {seg}
          </code>
        ) : seg
      );
    }

    // Links: [text](url)
    if (typeof processed === "string" && processed.includes("](")) {
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      const segments: React.ReactNode[] = [];
      let lastIndex = 0;
      let match;
      while ((match = linkRegex.exec(processed)) !== null) {
        if (match.index > lastIndex) segments.push(processed.slice(lastIndex, match.index));
        segments.push(
          <a key={match.index} href={match[2]} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80 transition-opacity">
            {match[1]}
          </a>
        );
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < processed.length) segments.push(processed.slice(lastIndex));
      processed = segments;
    }

    if (line.startsWith("### ")) {
      parts.push(<h3 key={key++} className="mt-4 mb-1.5 text-base font-semibold text-foreground">{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      parts.push(<h2 key={key++} className="mt-5 mb-2 text-lg font-bold text-foreground">{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      parts.push(<h1 key={key++} className="mt-5 mb-2 text-xl font-bold text-foreground">{line.slice(2)}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      parts.push(
        <li key={key++} className="ml-5 list-disc leading-relaxed">
          {typeof processed === "string" ? line.slice(2) : <>{Array.isArray(processed) ? processed : line.slice(2)}</>}
        </li>
      );
    } else if (/^\d+\.\s/.test(line)) {
      parts.push(
        <li key={key++} className="ml-5 list-decimal leading-relaxed">
          {typeof processed === "string" ? line.replace(/^\d+\.\s/, "") : processed}
        </li>
      );
    } else if (line.startsWith("> ")) {
      parts.push(
        <blockquote key={key++} className="my-2 border-l-2 border-muted-foreground/40 pl-4 italic text-muted-foreground text-sm">
          {line.slice(2)}
        </blockquote>
      );
    } else if (line === "---" || line === "***") {
      parts.push(<hr key={key++} className="my-3 border-border" />);
    } else if (line === "") {
      parts.push(<br key={key++} />);
    } else {
      parts.push(<p key={key++} className="my-0.5 leading-relaxed">{processed}</p>);
    }
  });

  if (inCodeBlock) flushCode();
  return parts;
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [liked, setLiked] = useState<boolean | null>(null);
  const isUser = message.role === "user";

  const { state: voiceState, supported: voiceSupported, speak, stopSpeaking } = useVoice();
  const isSpeaking = voiceState === "speaking";

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  const handleSpeak = useCallback(() => {
    if (isSpeaking) {
      stopSpeaking();
    } else {
      speak(message.content);
    }
  }, [isSpeaking, speak, stopSpeaking, message.content]);

  return (
    <div className={`animate-fade-in-up py-3 ${isUser ? "flex justify-end" : ""}`}>
      <div className={`flex gap-3 ${isUser ? "flex-row-reverse max-w-[85%] sm:max-w-[75%]" : "max-w-full"}`}>
        {/* Avatar */}
        {!isUser && (
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground mt-0.5">
            <Sparkles className="h-3.5 w-3.5" />
          </div>
        )}

        <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
          {/* User image attachment */}
          {isUser && message.image_url && (
            <div className="mb-2 flex justify-end">
              <img
                src={message.image_url}
                alt="Attached"
                className="max-h-48 rounded-xl object-cover border border-border"
              />
            </div>
          )}

          {/* Thinking block */}
          {!isUser && message.thinking && (
            <div className="mb-3">
              <button
                onClick={() => setThinkingOpen(!thinkingOpen)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Brain className="h-3.5 w-3.5" />
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
            ? "inline-block rounded-2xl rounded-tr-sm bg-user-bubble px-4 py-2.5 text-left text-user-bubble-foreground shadow-sm"
            : "text-foreground"
          }>
            <div className="text-[15px] leading-relaxed break-words">
              {isStreaming && !isUser && !message.content ? (
                <div className="flex items-center gap-2 text-muted-foreground py-1">
                  <div className="flex gap-1">
                    <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                    <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                    <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              ) : (
                <>
                  {renderContent(message.content)}
                  {isStreaming && !isUser && (
                    <span className="inline-block w-1.5 h-5 bg-foreground ml-0.5 animate-blink" />
                  )}
                </>
              )}
            </div>
          </div>

          {/* Action bar for assistant messages */}
          {!isUser && !isStreaming && message.content && (
            <div className="mt-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleCopy}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                title={copied ? "Скопировано!" : "Копировать"}
              >
                <Copy className={`h-3.5 w-3.5 ${copied ? "text-primary" : ""}`} />
              </button>
              {voiceSupported && (
                <button
                  onClick={handleSpeak}
                  className={`rounded-lg p-1.5 transition-colors ${
                    isSpeaking
                      ? "text-primary bg-primary/10"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                  title={isSpeaking ? "Остановить" : "Озвучить"}
                >
                  {isSpeaking ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                </button>
              )}
              <button
                onClick={() => setLiked(liked === true ? null : true)}
                className={`rounded-lg p-1.5 transition-colors ${
                  liked === true ? "text-primary bg-primary/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
                title="Хороший ответ"
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setLiked(liked === false ? null : false)}
                className={`rounded-lg p-1.5 transition-colors ${
                  liked === false ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
                title="Плохой ответ"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
              <button className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors" title="Перегенерировать">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Edit for user messages */}
          {isUser && !isStreaming && (
            <div className="mt-1 flex justify-end">
              <button className="rounded-lg p-1 text-muted-foreground hover:text-foreground transition-colors opacity-0 hover:opacity-100" title="Редактировать">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
