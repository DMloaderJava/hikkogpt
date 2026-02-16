import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`;

let chatIdCounter = 0;
let messageIdCounter = 0;

const generateId = (prefix: string) => `${prefix}_${++chatIdCounter}_${Date.now()}`;
const generateMsgId = () => `msg_${++messageIdCounter}_${Date.now()}`;

export function useChat() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedModel, setSelectedModel] = useState("GPT-4o");
  const abortRef = useRef<AbortController | null>(null);

  const activeChat = chats.find((c) => c.id === activeChatId) || null;

  const createNewChat = useCallback(() => {
    const newChat: Chat = {
      id: generateId("chat"),
      title: "Новый чат",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setChats((prev) => [newChat, ...prev]);
    setActiveChatId(newChat.id);
    return newChat.id;
  }, []);

  const deleteChat = useCallback(
    (chatId: string) => {
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChatId === chatId) {
        setActiveChatId(null);
      }
    },
    [activeChatId]
  );

  const renameChat = useCallback((chatId: string, title: string) => {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, title } : c))
    );
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      let chatId = activeChatId;
      let existingMessages: Message[] = [];

      if (!chatId) {
        const newChat: Chat = {
          id: generateId("chat"),
          title: content.slice(0, 30) + (content.length > 30 ? "..." : ""),
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        setChats((prev) => [newChat, ...prev]);
        chatId = newChat.id;
        setActiveChatId(chatId);
      } else {
        existingMessages = chats.find((c) => c.id === chatId)?.messages || [];
      }

      const userMessage: Message = {
        id: generateMsgId(),
        role: "user",
        content,
        timestamp: new Date(),
      };

      const assistantMsgId = generateMsgId();

      // Add user message
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c;
          const isFirst = c.messages.length === 0;
          return {
            ...c,
            messages: [...c.messages, userMessage],
            title: isFirst
              ? content.slice(0, 30) + (content.length > 30 ? "..." : "")
              : c.title,
            updatedAt: new Date(),
          };
        })
      );

      // Build messages for API
      const apiMessages = [
        ...existingMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content },
      ];

      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const resp = await fetch(CHAT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({ messages: apiMessages }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          const errMsg = errData.error || `Ошибка: ${resp.status}`;
          toast.error(errMsg);
          setIsStreaming(false);
          return;
        }

        if (!resp.body) {
          toast.error("Нет ответа от сервера");
          setIsStreaming(false);
          return;
        }

        // Add empty assistant message
        setChats((prev) =>
          prev.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  messages: [
                    ...c.messages,
                    { id: assistantMsgId, role: "assistant" as const, content: "", timestamp: new Date() },
                  ],
                }
              : c
          )
        );

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let textBuffer = "";
        let assistantSoFar = "";
        let streamDone = false;

        while (!streamDone) {
          const { done, value } = await reader.read();
          if (done) break;
          textBuffer += decoder.decode(value, { stream: true });

          let newlineIndex: number;
          while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
            let line = textBuffer.slice(0, newlineIndex);
            textBuffer = textBuffer.slice(newlineIndex + 1);

            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line.startsWith(":") || line.trim() === "") continue;
            if (!line.startsWith("data: ")) continue;

            const jsonStr = line.slice(6).trim();
            if (jsonStr === "[DONE]") {
              streamDone = true;
              break;
            }

            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta?.content as string | undefined;
              if (delta) {
                assistantSoFar += delta;
                const snapshot = assistantSoFar;
                setChats((prev) =>
                  prev.map((c) =>
                    c.id === chatId
                      ? {
                          ...c,
                          messages: c.messages.map((m) =>
                            m.id === assistantMsgId ? { ...m, content: snapshot } : m
                          ),
                        }
                      : c
                  )
                );
              }
            } catch {
              textBuffer = line + "\n" + textBuffer;
              break;
            }
          }
        }

        // Final flush
        if (textBuffer.trim()) {
          for (let raw of textBuffer.split("\n")) {
            if (!raw) continue;
            if (raw.endsWith("\r")) raw = raw.slice(0, -1);
            if (raw.startsWith(":") || raw.trim() === "") continue;
            if (!raw.startsWith("data: ")) continue;
            const jsonStr = raw.slice(6).trim();
            if (jsonStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta?.content as string | undefined;
              if (delta) {
                assistantSoFar += delta;
                const snapshot = assistantSoFar;
                setChats((prev) =>
                  prev.map((c) =>
                    c.id === chatId
                      ? {
                          ...c,
                          messages: c.messages.map((m) =>
                            m.id === assistantMsgId ? { ...m, content: snapshot } : m
                          ),
                        }
                      : c
                  )
                );
              }
            } catch { /* ignore */ }
          }
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // User stopped
        } else {
          console.error("Stream error:", e);
          toast.error("Ошибка при получении ответа");
        }
      }

      setIsStreaming(false);
      abortRef.current = null;
    },
    [activeChatId, chats]
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  return {
    chats,
    activeChat,
    activeChatId,
    isStreaming,
    selectedModel,
    setSelectedModel,
    setActiveChatId,
    createNewChat,
    deleteChat,
    renameChat,
    sendMessage,
    stopStreaming,
  };
}
