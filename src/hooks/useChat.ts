import { useState, useCallback } from "react";

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

const SAMPLE_RESPONSES = [
  "Привет! Я готов помочь вам с любыми вопросами. Чем могу быть полезен?\n\nВот несколько примеров того, что я умею:\n\n- **Отвечать на вопросы** по различным темам\n- **Помогать с кодом** — писать, отлаживать, объяснять\n- **Генерировать тексты** — статьи, письма, сценарии\n- **Анализировать данные** и предлагать решения",
  "Отличный вопрос! Давайте разберёмся подробнее.\n\nВот пример кода на Python:\n\n```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n - 1) + fibonacci(n - 2)\n\n# Вывод первых 10 чисел\nfor i in range(10):\n    print(fibonacci(i))\n```\n\nЭтот рекурсивный подход прост, но для больших значений `n` лучше использовать итеративный вариант или мемоизацию.",
  "Конечно! Вот несколько полезных советов:\n\n1. **Будьте конкретны** — чем точнее запрос, тем лучше ответ\n2. **Задавайте уточняющие вопросы** — не стесняйтесь переспрашивать\n3. **Экспериментируйте** — попробуйте разные формулировки\n\n> \"Единственный способ делать великую работу — любить то, что делаешь.\" — Стив Джобс",
];

let chatIdCounter = 0;
let messageIdCounter = 0;

const generateId = (prefix: string) => `${prefix}_${++chatIdCounter}_${Date.now()}`;
const generateMsgId = () => `msg_${++messageIdCounter}_${Date.now()}`;

export function useChat() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedModel, setSelectedModel] = useState("GPT-4o");

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
      }

      const userMessage: Message = {
        id: generateMsgId(),
        role: "user",
        content,
        timestamp: new Date(),
      };

      // Update title if first message
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

      // Simulate streaming response
      setIsStreaming(true);
      const responseText =
        SAMPLE_RESPONSES[Math.floor(Math.random() * SAMPLE_RESPONSES.length)];

      const assistantMessage: Message = {
        id: generateMsgId(),
        role: "assistant",
        content: "",
        timestamp: new Date(),
      };

      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? { ...c, messages: [...c.messages, assistantMessage] }
            : c
        )
      );

      // Stream character by character
      for (let i = 0; i <= responseText.length; i++) {
        await new Promise((r) => setTimeout(r, 15));
        const partial = responseText.slice(0, i);
        setChats((prev) =>
          prev.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === assistantMessage.id
                      ? { ...m, content: partial }
                      : m
                  ),
                }
              : c
          )
        );
      }

      setIsStreaming(false);
    },
    [activeChatId]
  );

  const stopStreaming = useCallback(() => {
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
