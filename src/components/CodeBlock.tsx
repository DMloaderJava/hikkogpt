import { useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/atom-one-dark.css";

interface CodeBlockProps {
  code: string;
  lang?: string;
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => {
    const language = (lang || "").toLowerCase().trim();
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [code, lang]);

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded-lg overflow-hidden animate-fade-in-up">
      <div className="flex items-center justify-between bg-code-block-header px-3 sm:px-4 py-2 text-xs text-code-block-foreground">
        <span className="font-mono opacity-80">{lang || "code"}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 btn-interactive rounded px-1.5 py-0.5 transition-all"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-interactive" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Скопировано" : "Copy"}
        </button>
      </div>
      <pre className="hljs bg-code-block p-3 sm:p-4 overflow-x-auto text-xs sm:text-sm">
        {html !== null ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code className="text-code-block-foreground">{code}</code>
        )}
      </pre>
    </div>
  );
}
