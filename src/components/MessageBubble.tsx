import { Copy, ThumbsUp, ThumbsDown, RotateCcw, Volume2, Pencil, Sparkles, ChevronDown, ChevronRight, Brain } from "lucide-react";
import { useState } from "react";
import type { Message } from "@/hooks/useChat";

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

    // Image markdown: ![alt](url)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      parts.push(
        <img
          key={key++}
          src={imgMatch[2]}
          alt={imgMatch[1]}
          className="my-3 max-w-full rounded-lg"
          loading="lazy"
        />
      );
      return;
    }

    // Inline markdown
    let processed: React.ReactNode = line;

    // Bold
    if (line.includes("**")) {
      const segments = line.split(/\*\*(.*?)\*\*/g);
      processed = segments.map((seg, i) =>
        i % 2 === 1 ? <strong key={i}>{seg}</strong> : seg
      );
    }

    // Inline code
    if (typeof processed === "string" && processed.includes("`")) {
      const segments = processed.split(/`([^`]+)`/g);
      processed = segments.map((seg, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-code-block px-1.5 py-0.5 text-sm text-code-block-foreground">
            {seg}
          </code>
        ) : (
          seg
        )
      );
    }

    // Headers
    if (line.startsWith("### ")) {
      parts.push(<h3 key={key++} className="mt-3 mb-1 text-base font-semibold">{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      parts.push(<h2 key={key++} className="mt-4 mb-1 text-lg font-bold">{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      parts.push(<h1 key={key++} className="mt-4 mb-2 text-xl font-bold">{line.slice(2)}</h1>);
    } else if (line.startsWith("- ")) {
      parts.push(
        <li key={key++} className="ml-4 list-disc">
          {typeof processed === "string" ? line.slice(2) : <>{Array.isArray(processed) ? processed : line.slice(2)}</>}
        </li>
      );
    } else if (/^\d+\.\s/.test(line)) {
      parts.push(
        <li key={key++} className="ml-4 list-decimal">
          {typeof processed === "string" ? line.replace(/^\d+\.\s/, "") : processed}
        </li>
      );
    } else if (line.startsWith("> ")) {
      parts.push(
        <blockquote key={key++} className="my-2 border-l-2 border-muted-foreground/30 pl-4 italic text-muted-foreground">
          {line.slice(2)}
        </blockquote>
      );
    } else if (line === "") {
      parts.push(<br key={key++} />);
    } else {
      parts.push(<p key={key++} className="my-0.5">{processed}</p>);
    }
  });

  if (inCodeBlock) flushCode();

  return parts;
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const isUser = message.role === "user";

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`animate-fade-in-up py-4 ${isUser ? "flex justify-end" : ""}`}>
      <div className={`flex gap-3 max-w-3xl ${isUser ? "flex-row-reverse" : ""}`}>
        {/* Avatar */}
        {!isUser && (
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
        )}

        {/* Content */}
        <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
          {/* User image attachment */}
          {isUser && message.image_url && (
            <div className="mb-2 flex justify-end">
              <img
                src={message.image_url}
                alt="Attached"
                className="max-h-48 rounded-lg object-cover border border-border"
              />
            </div>
          )}

          {/* Thinking block */}
          {!isUser && message.thinking && (
            <div className="mb-2">
              <button
                onClick={() => setThinkingOpen(!thinkingOpen)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Brain className="h-3.5 w-3.5" />
                <span>Размышления</span>
                {thinkingOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              {thinkingOpen && (
                <div className="mt-1.5 rounded-lg border border-border bg-secondary/50 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {message.thinking}
                </div>
              )}
            </div>
          )}

          <div
            className={
              isUser
                ? "inline-block rounded-2xl bg-user-bubble px-4 py-2.5 text-left text-user-bubble-foreground"
                : "text-foreground"
            }
          >
            <div className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
              {renderContent(message.content)}
              {isStreaming && !isUser && (
                <span className="inline-block w-1.5 h-5 bg-foreground ml-0.5 animate-blink" />
              )}
            </div>
          </div>

          {/* Action bar for assistant messages */}
          {!isUser && !isStreaming && message.content && (
            <div className="mt-2 flex items-center gap-1">
              <button onClick={handleCopy} className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors" title="Копировать">
                <Copy className="h-4 w-4" />
              </button>
              <button className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors" title="Озвучить">
                <Volume2 className="h-4 w-4" />
              </button>
              <button className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors" title="Хороший ответ">
                <ThumbsUp className="h-4 w-4" />
              </button>
              <button className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors" title="Плохой ответ">
                <ThumbsDown className="h-4 w-4" />
              </button>
              <button className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors" title="Перегенерировать">
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Edit for user messages */}
          {isUser && (
            <div className="mt-1 flex justify-end">
              <button className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors" title="Редактировать">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
