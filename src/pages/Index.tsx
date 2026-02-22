import { useState, useRef, useEffect, useCallback } from "react";
import { Menu, Share, Moon, Sun, LogOut, Brain } from "lucide-react";
import { ChatSidebar } from "@/components/ChatSidebar";
import { ChatInput } from "@/components/ChatInput";
import { MessageBubble } from "@/components/MessageBubble";
import { EmptyState } from "@/components/EmptyState";
import { ModelSelector } from "@/components/ModelSelector";
import { DeepSearchPanel } from "@/components/DeepSearchPanel";
import { useChat } from "@/hooks/useChat";
import { useDeepSearch } from "@/hooks/useDeepSearch";
import { useTheme } from "@/hooks/useTheme";
import { useAuth } from "@/hooks/useAuth";

const Index = () => {
  const {
    chats,
    activeChat,
    activeChatId,
    isStreaming,
    selectedModel,
    thinkingEnabled,
    setThinkingEnabled,
    setSelectedModel,
    setActiveChatId,
    createNewChat,
    deleteChat,
    renameChat,
    sendMessage,
    stopStreaming,
  } = useChat();

  const {
    deepSearch,
    startClarify,
    startSearch,
    stopSearch,
    resetDeepSearch,
    resetDeepSearchForNewChat,
  } = useDeepSearch();

  const { isDark, toggle: toggleTheme } = useTheme();
  const { user, signOut } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [deepSearchQuery, setDeepSearchQuery] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeChat?.messages, deepSearch.report]);

  // Reset deep search state when switching chats
  const prevChatIdRef = useRef(activeChatId);
  useEffect(() => {
    if (prevChatIdRef.current !== activeChatId) {
      resetDeepSearchForNewChat();
      setDeepSearchQuery("");
      prevChatIdRef.current = activeChatId;
    }
  }, [activeChatId, resetDeepSearchForNewChat]);

  const characters = ["Илон Маск", "Прохожий0"];

  const handleModelSelect = useCallback((model: string) => {
    setSelectedModel(model);
    if (characters.includes(model)) {
      setActiveChatId(null);
    }
  }, [setSelectedModel, setActiveChatId]);

  const handleSuggestionClick = (text: string) => {
    sendMessage(text);
  };

  const handleDeepSearch = useCallback(async (query: string) => {
    if (deepSearch.used) return;

    if (deepSearch.phase === "idle") {
      // First time: ask clarifying questions
      setDeepSearchQuery(query);
      // Add the user query as a message first
      await sendMessage(`🔍 **Глубокий поиск:** ${query}`);
      await startClarify(query);
    }
  }, [deepSearch.phase, deepSearch.used, startClarify, sendMessage]);

  // When clarifying questions arrive, inject them as assistant message
  useEffect(() => {
    if (deepSearch.phase === "waiting_answers" && deepSearch.questions.length > 0) {
      const questionsText = deepSearch.questions
        .map((q, i) => `${i + 1}. ${q}`)
        .join("\n");
      sendMessage(""); // dummy - we'll inject directly
      // Actually let's add the questions as a fake send
    }
  }, [deepSearch.phase]); // intentionally minimal deps

  // Handle answers to clarifying questions
  const handleSendWithDeepSearchCheck = useCallback(
    async (content: string, imageBase64?: string) => {
      if (deepSearch.phase === "waiting_answers" && content.trim()) {
        // User is answering clarifying questions - start the search
        await sendMessage(content, imageBase64);
        startSearch(deepSearchQuery, content);
        return;
      }
      sendMessage(content, imageBase64);
    },
    [deepSearch.phase, deepSearchQuery, sendMessage, startSearch]
  );

  const messages = activeChat?.messages || [];

  // Build displayed messages including deep search injections
  const displayMessages = [...messages];

  // Inject clarifying questions as assistant message if in waiting_answers phase
  if (deepSearch.phase === "waiting_answers" && deepSearch.questions.length > 0) {
    const questionsText = `Прежде чем начать глубокий поиск, мне нужно уточнить несколько моментов:\n\n${deepSearch.questions.map((q, i) => `**${i + 1}.** ${q}`).join("\n\n")}\n\nОтветьте на эти вопросы, и я начну поиск.`;
    displayMessages.push({
      id: "deepsearch-questions",
      role: "assistant",
      content: questionsText,
      timestamp: new Date(),
    });
  }

  // Inject deep search report
  if (deepSearch.report) {
    const sourcesText = deepSearch.sources.length > 0
      ? `\n\n---\n\n**Источники:**\n${deepSearch.sources.map((s) => `${s.index}. [${s.title}](${s.url})`).join("\n")}`
      : "";
    displayMessages.push({
      id: "deepsearch-report",
      role: "assistant",
      content: deepSearch.report + sourcesText,
      timestamp: new Date(),
    });
  }

  const isDeepSearchActive = deepSearch.phase === "searching" || deepSearch.phase === "clarifying";

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* Sidebar */}
      <div
        className={`flex-shrink-0 transition-all duration-300 ${
          sidebarOpen ? "w-64" : "w-0"
        } overflow-hidden border-r border-sidebar-border`}
      >
        <div className="h-full w-64">
          <ChatSidebar
            chats={chats}
            activeChatId={activeChatId}
            userEmail={user?.email}
            onNewChat={createNewChat}
            onSelectChat={setActiveChatId}
            onDeleteChat={deleteChat}
            onRenameChat={renameChat}
          />
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <Menu className="h-5 w-5" />
            </button>
            <ModelSelector selectedModel={selectedModel} onSelect={handleModelSelect} />
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setThinkingEnabled(!thinkingEnabled)}
              className={`rounded-lg p-2 transition-colors ${
                thinkingEnabled
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
              title={thinkingEnabled ? "Thinking mode включён" : "Включить thinking mode"}
            >
              <Brain className="h-5 w-5" />
            </button>
            <button
              onClick={toggleTheme}
              className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            <button className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">
              <Share className="h-5 w-5" />
            </button>
            <button
              onClick={signOut}
              className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              title="Выйти"
            >
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Chat content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {displayMessages.length === 0 ? (
            <EmptyState onSuggestionClick={handleSuggestionClick} />
          ) : (
            <div className="flex-1 overflow-y-auto px-4 scrollbar-thin">
              <div className="mx-auto max-w-3xl">
                {displayMessages.map((msg, i) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isStreaming={
                      (isStreaming && i === displayMessages.length - 1 && msg.role === "assistant") ||
                      (msg.id === "deepsearch-report" && deepSearch.phase === "searching")
                    }
                  />
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>
          )}

          <DeepSearchPanel deepSearch={deepSearch} />

          {/* Input */}
          <ChatInput
            onSend={handleSendWithDeepSearchCheck}
            isStreaming={isStreaming || isDeepSearchActive}
            onStop={isDeepSearchActive ? stopSearch : stopStreaming}
            deepSearchUsed={deepSearch.used}
            onDeepSearch={handleDeepSearch}
          />
        </div>
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
};

export default Index;
