import { useState, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useSounds } from "@/hooks/useSounds";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  image_url?: string;
  images?: string[];
  thinking?: string;
  timestamp: Date;
}

export interface Chat {
  id: string;
  title: string;
  model: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`;
const IMAGE_SEARCH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/image-search`;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Resolves [IMAGE_SEARCH: query] tags → markdown images
async function resolveImageSearchTags(text: string): Promise<string> {
  const tagRegex = /\[IMAGE_SEARCH:\s*([^\]]+)\]/g;
  const matches = [...text.matchAll(tagRegex)];
  if (matches.length === 0) return text;

  // Resolve all image searches in parallel
  const results = await Promise.allSettled(
    matches.map(async (match) => {
      const query = match[1].trim();
      try {
        const { getEdgeAuthHeaders } = await import("@/lib/edgeAuth");
        const resp = await fetch(IMAGE_SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getEdgeAuthHeaders()) },
          body: JSON.stringify({ query }),
        });
        if (!resp.ok) return { match: match[0], replacement: "" };
        const data = await resp.json();
        const imgs: { url: string; title: string }[] = data.results || [];
        if (imgs.length === 0) return { match: match[0], replacement: "" };
        const mdImages = imgs.slice(0, 3).map(img => `![${img.title || query}](${img.url})`).join("\n");
        return { match: match[0], replacement: `\n${mdImages}\n` };
      } catch {
        return { match: match[0], replacement: "" };
      }
    })
  );

  let result = text;
  for (const r of results) {
    if (r.status === "fulfilled") {
      result = result.replace(r.value.match, r.value.replacement);
    }
  }
  return result;
}

export function useChat() {
  const { user } = useAuth();
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedModel, setSelectedModel] = useState("HikkoGPT Smart");
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [soundsEnabled, setSoundsEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("hikko_sounds") !== "0";
  });
  const { play: playSound } = useSounds(soundsEnabled);
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(false);

  const toggleSounds = useCallback(() => {
    setSoundsEnabled((v) => {
      const nv = !v;
      try { localStorage.setItem("hikko_sounds", nv ? "1" : "0"); } catch {}
      return nv;
    });
  }, []);

  const activeChat = chats.find((c) => c.id === activeChatId) || null;

  // Load chats list (without messages) on mount
  useEffect(() => {
    if (!user || loadedRef.current) return;
    loadedRef.current = true;

    (async () => {
      const { data: dbChats, error } = await supabase
        .from("chats")
        .select("*")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });

      if (error || !dbChats) return;

      const chatList: Chat[] = dbChats.map((c) => ({
        id: c.id,
        title: c.title,
        model: c.model,
        messages: [],
        createdAt: new Date(c.created_at),
        updatedAt: new Date(c.updated_at),
      }));
      setChats(chatList);
    })();
  }, [user]);

  // Load messages only when a chat is selected
  const loadingMsgsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!activeChatId || !user) return;
    const chat = chats.find((c) => c.id === activeChatId);
    // Skip if messages already loaded or currently loading
    if (!chat || chat.messages.length > 0 || loadingMsgsRef.current.has(activeChatId)) return;

    loadingMsgsRef.current.add(activeChatId);
    const chatId = activeChatId;

    (async () => {
      const { data: msgs } = await supabase
        .from("messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? {
                ...c,
                messages: (msgs || []).map((m: any) => ({
                  id: m.id,
                  role: m.role,
                  content: m.content,
                  image_url: m.image_url || undefined,
                  timestamp: new Date(m.created_at),
                })),
              }
            : c
        )
      );
      loadingMsgsRef.current.delete(chatId);
    })();
  }, [activeChatId, user, chats]);

  const createNewChat = useCallback(async () => {
    if (!user) return "";
    const { data, error } = await supabase
      .from("chats")
      .insert({ user_id: user.id, title: "Новый чат", model: selectedModel })
      .select()
      .single();

    if (error || !data) {
      toast.error("Не удалось создать чат");
      return "";
    }

    const newChat: Chat = {
      id: data.id,
      title: data.title,
      model: data.model,
      messages: [],
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
    };
    setChats((prev) => [newChat, ...prev]);
    setActiveChatId(newChat.id);
    return newChat.id;
  }, [user, selectedModel]);

  const deleteChat = useCallback(
    async (chatId: string) => {
      await supabase.from("chats").delete().eq("id", chatId);
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChatId === chatId) setActiveChatId(null);
    },
    [activeChatId]
  );

  const renameChat = useCallback(async (chatId: string, title: string) => {
    await supabase.from("chats").update({ title }).eq("id", chatId);
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, title } : c))
    );
  }, []);

  const sendMessage = useCallback(
    async (content: string, images?: string[]) => {
      if (!user) return;
      let chatId = activeChatId;
      let existingMessages: Message[] = [];

      // Create chat if none active
      if (!chatId) {
        const title = content.slice(0, 30) + (content.length > 30 ? "..." : "");
        const { data, error } = await supabase
          .from("chats")
          .insert({ user_id: user.id, title, model: selectedModel })
          .select()
          .single();

        if (error || !data) {
          toast.error("Не удалось создать чат");
          return;
        }
        chatId = data.id;
        const newChat: Chat = {
          id: data.id,
          title: data.title,
          model: data.model,
          messages: [],
          createdAt: new Date(data.created_at),
          updatedAt: new Date(data.updated_at),
        };
        setChats((prev) => [newChat, ...prev]);
        setActiveChatId(chatId);
      } else {
        existingMessages = chats.find((c) => c.id === chatId)?.messages || [];
      }

      // Use first image for DB storage (legacy single image_url column)
      const firstImage = images?.[0] || null;

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        image_url: firstImage || undefined,
        images: images || undefined,
        timestamp: new Date(),
      };

      // Update UI immediately, DB writes in background
      const isFirst = existingMessages.length === 0;
      const title = isFirst ? content.slice(0, 30) + (content.length > 30 ? "..." : "") : undefined;

      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? { ...c, ...(title ? { title } : {}), messages: [...c.messages, userMessage], updatedAt: new Date() }
            : c
        )
      );

      // Play send sound
      playSound("send");

      // Fire DB writes in parallel, don't await them before streaming
      const dbWrites = Promise.all([
        supabase.from("messages").insert({ chat_id: chatId, role: "user", content, image_url: firstImage }),
        ...(title ? [supabase.from("chats").update({ title }).eq("id", chatId)] : []),
      ]);

      // Build API messages (support multiple images)
      const apiMessages = [
        ...existingMessages.map((m) => {
          const imgs = m.images || (m.image_url ? [m.image_url] : []);
          if (imgs.length > 0) {
            return {
              role: m.role,
              content: [
                { type: "text", text: m.content },
                ...imgs.map(url => ({ type: "image_url", image_url: { url } })),
              ],
            };
          }
          return { role: m.role, content: m.content };
        }),
        images && images.length > 0
          ? {
              role: "user" as const,
              content: [
                { type: "text", text: content },
                ...images.map(url => ({ type: "image_url", image_url: { url } })),
              ],
            }
          : { role: "user" as const, content },
      ];

      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const assistantMsgId = crypto.randomUUID();

      // Add empty assistant message
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? { ...c, messages: [...c.messages, { id: assistantMsgId, role: "assistant" as const, content: "", thinking: "", timestamp: new Date() }] }
            : c
        )
      );

      try {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        const resp = await fetch(CHAT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ messages: apiMessages, model: selectedModel, thinking: thinkingEnabled }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          toast.error(errData.error || `Ошибка: ${resp.status}`);
          setIsStreaming(false);
          return;
        }

        if (!resp.body) {
          toast.error("Нет ответа от сервера");
          setIsStreaming(false);
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let textBuffer = "";
        let assistantSoFar = "";
        let thinkingSoFar = "";
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
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;

              // Check for thinking content
              if (delta?.reasoning_content) {
                thinkingSoFar += delta.reasoning_content;
              }

              const textDelta = delta?.content as string | undefined;
              if (textDelta) {
                if (assistantSoFar === "") playSound("receive");
                assistantSoFar += textDelta;
              }

              if (textDelta || delta?.reasoning_content) {
                const contentSnap = assistantSoFar;
                const thinkingSnap = thinkingSoFar;
                setChats((prev) =>
                  prev.map((c) =>
                    c.id === chatId
                      ? {
                          ...c,
                          messages: c.messages.map((m) =>
                            m.id === assistantMsgId ? { ...m, content: contentSnap, thinking: thinkingSnap } : m
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
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.reasoning_content) thinkingSoFar += delta.reasoning_content;
              if (delta?.content) assistantSoFar += delta.content;
            } catch { /* ignore */ }
          }
          const contentSnap = assistantSoFar;
          const thinkingSnap = thinkingSoFar;
          setChats((prev) =>
            prev.map((c) =>
              c.id === chatId
                ? {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === assistantMsgId ? { ...m, content: contentSnap, thinking: thinkingSnap } : m
                    ),
                  }
                : c
            )
          );
        }

        // Resolve [IMAGE_SEARCH: ...] tags → real images
        if (assistantSoFar.includes("[IMAGE_SEARCH:")) {
          const resolved = await resolveImageSearchTags(assistantSoFar);
          assistantSoFar = resolved;
          setChats((prev) =>
            prev.map((c) =>
              c.id === chatId
                ? {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === assistantMsgId ? { ...m, content: resolved } : m
                    ),
                  }
                : c
            )
          );
        }

        // Ensure earlier DB writes finished, then save assistant message in parallel with updated_at
        await dbWrites;
        Promise.all([
          supabase.from("messages").insert({ chat_id: chatId, role: "assistant", content: assistantSoFar }),
          supabase.from("chats").update({ updated_at: new Date().toISOString() }).eq("id", chatId),
        ]);
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
    [activeChatId, chats, selectedModel, thinkingEnabled, user]
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
    thinkingEnabled,
    soundsEnabled,
    toggleSounds,
    setThinkingEnabled,
    setSelectedModel,
    setActiveChatId,
    createNewChat,
    deleteChat,
    renameChat,
    sendMessage,
    stopStreaming,
  };
}
