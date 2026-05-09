import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { getEdgeAuthHeaders } from "@/lib/edgeAuth";

const DEEPSEARCH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/deepsearch`;

export type DeepSearchPhase =
  | "idle"
  | "clarifying"
  | "waiting_answers"
  | "generating_queries"
  | "searching"
  | "analyzing"
  | "done"
  | "error";

export interface DeepSearchState {
  phase: DeepSearchPhase;
  questions: string[];
  statusMessage: string;
  report: string;
  sources: { index: number; title: string; url: string }[];
  used: boolean;
}

const initialState: DeepSearchState = {
  phase: "idle",
  questions: [],
  statusMessage: "",
  report: "",
  sources: [],
  used: false,
};

export function useDeepSearch() {
  const [state, setState] = useState<DeepSearchState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setState((prev) => ({ ...initialState, used: prev.used }));
  }, []);

  const resetForNewChat = useCallback(() => {
    setState(initialState);
  }, []);

  const startClarify = useCallback(async (query: string) => {
    setState((prev) => ({ ...prev, phase: "clarifying", statusMessage: "Генерирую уточняющие вопросы..." }));

    try {
      const resp = await fetch(DEEPSEARCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getEdgeAuthHeaders()) },
        body: JSON.stringify({ action: "clarify", query }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      setState((prev) => ({
        ...prev,
        phase: "waiting_answers",
        questions: data.questions || [],
        statusMessage: "Ожидаю ответы на вопросы...",
      }));
    } catch (e) {
      console.error("Clarify error:", e);
      toast.error("Ошибка при генерации вопросов");
      setState((prev) => ({ ...prev, phase: "error", statusMessage: "Ошибка" }));
    }
  }, []);

  const startSearch = useCallback(async (query: string, answers: string) => {
    setState((prev) => ({
      ...prev,
      phase: "generating_queries",
      statusMessage: "Генерирую поисковые запросы...",
      report: "",
      sources: [],
    }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch(DEEPSEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ action: "search", query, answers }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, nlIdx);
          textBuffer = textBuffer.slice(nlIdx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const event = parsed.event;

            if (event === "status") {
              // Map status messages to phases
              const msg: string = parsed.message || "";
              let newPhase: DeepSearchPhase = state.phase;
              if (msg.includes("поисковые запросы") || msg.includes("Создано")) {
                newPhase = "generating_queries";
              } else if (msg.includes("Ищу информацию") || msg.includes("Фильтрую")) {
                newPhase = "searching";
              } else if (msg.includes("Анализирую")) {
                newPhase = "analyzing";
              } else if (msg.includes("Формирую отчёт")) {
                newPhase = "analyzing";
              }
              setState((prev) => ({ ...prev, phase: newPhase, statusMessage: msg }));
            } else if (event === "delta") {
              // Once we get deltas, we're in analyzing/report phase
              setState((prev) => ({ ...prev, phase: "analyzing", report: prev.report + parsed.content }));
            } else if (event === "sources") {
              setState((prev) => ({ ...prev, sources: parsed.sources || [] }));
            } else if (event === "error") {
              toast.error(parsed.message || "Ошибка поиска");
              setState((prev) => ({ ...prev, phase: "error" }));
            }
          } catch { /* partial json */ }
        }
      }

      setState((prev) => ({ ...prev, phase: "done", used: true, statusMessage: "Отчёт готов" }));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      console.error("Search error:", e);
      toast.error("Ошибка при глубоком поиске");
      setState((prev) => ({ ...prev, phase: "error" }));
    }

    abortRef.current = null;
  }, []);

  const stopSearch = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, phase: "done", used: true, statusMessage: "" }));
  }, []);

  return {
    deepSearch: state,
    startClarify,
    startSearch,
    stopSearch,
    resetDeepSearch: reset,
    resetDeepSearchForNewChat: resetForNewChat,
  };
}
