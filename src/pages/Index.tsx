import { useState, useRef, useEffect, useCallback } from "react";
import { Menu, Share, Moon, Sun, LogOut, Brain, X, SquarePen } from "lucide-react";
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
import { useIsMobile } from "@/hooks/use-mobile";

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
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deepSearchQuery, setDeepSearchQuery] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // On desktop, sidebar is open by default
  useEffect(() => {
    if (!isMobile) {
      setSidebarOpen(true);
    } else {
      setSidebarOpen(false);
    }
  }, [isMobile]);

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
      setDeepSearchQuery(query);
      await sendMessage(`🔍 **Глубокий поиск:** ${query}`);
      await startClarify(query);
    }
  }, [deepSearch.phase, deepSearch.used, startClarify, sendMessage]);

  const handleSendWithDeepSearchCheck = useCallback(
    async (content: string, images?: string[]) => {
      if (deepSearch.phase === "waiting_answers" && content.trim()) {
        await sendMessage(content, images);
        startSearch(deepSearchQuery, content);
        return;
      }
      sendMessage(content, images);
    },
    [deepSearch.phase, deepSearchQuery, sendMessage, startSearch]
  );

  // Close sidebar on mobile when selecting a chat
  const handleSelectChat = useCallback((id: string) => {
    setActiveChatId(id);
    if (isMobile) setSidebarOpen(false);
  }, [setActiveChatId, isMobile]);

  const handleNewChat = useCallback(() => {
    createNewChat();
    if (isMobile) setSidebarOpen(false);
  }, [createNewChat, isMobile]);

  const messages = activeChat?.messages || [];

  const displayMessages = [...messages];

  if ((deepSearch.phase === "waiting_answers" || (deepSearch.questions.length > 0 && deepSearch.phase !== "idle")) && deepSearch.questions.length > 0) {
    const questionsText = `Прежде чем начать глубокий поиск, мне нужно уточнить несколько моментов:\n\n${deepSearch.questions.map((q, i) => `**${i + 1}.** ${q}`).join("\n\n")}\n\nОтветьте на эти вопросы, и я начну поиск.`;
    displayMessages.push({
      id: "deepsearch-questions",
      role: "assistant",
      content: questionsText,
      timestamp: new Date(),
    });
  }

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

  const isDeepSearchActive = deepSearch.phase === "searching" || deepSearch.phase === "clarifying" || deepSearch.phase === "generating_queries" || deepSearch.phase === "analyzing";

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* Mobile sidebar overlay */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          flex-shrink-0 transition-all duration-300 border-r border-sidebar-border
          ${isMobile
            ? `fixed inset-y-0 left-0 z-50 ${sidebarOpen ? "translate-x-0 w-[85vw] max-w-sm" : "-translate-x-full w-[85vw] max-w-sm"} transition-transform`
            : `${sidebarOpen ? "w-64" : "w-0"} overflow-hidden`
          }
        `}
      >
        <div className={isMobile ? "h-full" : "h-full w-64"}>
          {isMobile && sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(false)}
              className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-muted-foreground hover:bg-sidebar-accent transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <ChatSidebar
            chats={chats}
            activeChatId={activeChatId}
            userEmail={user?.email}
            onNewChat={handleNewChat}
            onSelectChat={handleSelectChat}
            onDeleteChat={deleteChat}
            onRenameChat={renameChat}
          />
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0 relative">

        {/* Desktop header */}
        {!isMobile && (
          <header className="flex items-center justify-between border-b border-border px-3 py-2 gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors flex-shrink-0"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="min-w-0 overflow-hidden">
                <ModelSelector selectedModel={selectedModel} onSelect={handleModelSelect} />
              </div>
            </div>

            <div className="flex items-center gap-0.5 flex-shrink-0">
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
        )}

        {/* Mobile floating header buttons */}
        {isMobile && (
          <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-2 pt-2 pointer-events-none">
            <button
              onClick={() => setSidebarOpen(true)}
              className="pointer-events-auto rounded-xl p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/* Mobile model selector centered */}
            <div className="pointer-events-auto">
              <ModelSelector selectedModel={selectedModel} onSelect={handleModelSelect} />
            </div>

            <div className="flex items-center gap-0.5 pointer-events-auto">
              <button
                onClick={() => setThinkingEnabled(!thinkingEnabled)}
                className={`rounded-xl p-2.5 transition-colors ${
                  thinkingEnabled
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                <Brain className="h-5 w-5" />
              </button>
              <button
                onClick={handleNewChat}
                className="rounded-xl p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                title="Новый чат"
              >
                <SquarePen className="h-5 w-5" />
              </button>
            </div>
          </div>
        )}

        {/* Chat content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {displayMessages.length === 0 ? (
            <EmptyState onSuggestionClick={handleSuggestionClick} isMobile={isMobile} />
          ) : (
            <div className={`flex-1 overflow-y-auto px-3 sm:px-4 scrollbar-thin ${isMobile ? "pt-14" : ""}`}>
              <div className="mx-auto max-w-3xl">
                {displayMessages.map((msg, i) => (
                  <div key={msg.id} className="group">
                    <MessageBubble
                      message={msg}
                      isStreaming={
                        (isStreaming && i === displayMessages.length - 1 && msg.role === "assistant") ||
                        (msg.id === "deepsearch-report" && deepSearch.phase === "searching")
                      }
                    />
                  </div>
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
    </div>
  );
};

export default Index;
