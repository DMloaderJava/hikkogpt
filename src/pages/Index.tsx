import { useState, useRef, useEffect, useCallback } from "react";
import { Menu, Brain, X, SquarePen, Settings, ChevronDown } from "lucide-react";
import { ChatSidebar } from "@/components/ChatSidebar";
import { ChatInput } from "@/components/ChatInput";
import { MessageBubble } from "@/components/MessageBubble";
import { EmptyState } from "@/components/EmptyState";
import { ModelSelector } from "@/components/ModelSelector";
import { DeepSearchPanel } from "@/components/DeepSearchPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useChat } from "@/hooks/useChat";
import { useDeepSearch } from "@/hooks/useDeepSearch";
import { useTheme } from "@/hooks/useTheme";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";

const Index = () => {
  const {
    chats, activeChat, activeChatId, isStreaming,
    selectedModel, thinkingEnabled, soundsEnabled, toggleSounds,
    setThinkingEnabled, setSelectedModel, setActiveChatId,
    createNewChat, deleteChat, renameChat, sendMessage, stopStreaming,
  } = useChat();

  const { deepSearch, startClarify, startSearch, stopSearch, resetDeepSearchForNewChat } = useDeepSearch();
  const { isDark, toggle: toggleTheme } = useTheme();
  const { user, signOut } = useAuth();
  const isMobile = useIsMobile();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deepSearchQuery, setDeepSearchQuery] = useState("");
  const [ttsVoice, setTtsVoice] = useState(() => localStorage.getItem("tts-voice") || "Aoede");
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const touchStartXRef = useRef<number>(0);
  const touchStartYRef = useRef<number>(0);

  const handleVoiceChange = (v: string) => {
    setTtsVoice(v);
    localStorage.setItem("tts-voice", v);
  };

  useEffect(() => {
    if (!isMobile) setSidebarOpen(true);
    else setSidebarOpen(false);
  }, [isMobile]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isNearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeChat?.messages, deepSearch.report]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distFromBottom > 200);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeChat]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
    touchStartYRef.current = e.touches[0].clientY;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const dx = touchStartXRef.current - e.changedTouches[0].clientX;
    const dy = Math.abs(touchStartYRef.current - e.changedTouches[0].clientY);
    if (dx > 60 && dy < 80 && sidebarOpen && isMobile) {
      setSidebarOpen(false);
    }
  }, [sidebarOpen, isMobile]);

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
    if (characters.includes(model)) setActiveChatId(null);
  }, [setSelectedModel, setActiveChatId]);

  const handleSuggestionClick = (text: string) => sendMessage(text);

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
    displayMessages.push({ id: "deepsearch-questions", role: "assistant", content: questionsText, timestamp: new Date() });
  }

  if (deepSearch.report) {
    const sourcesText = deepSearch.sources.length > 0
      ? `\n\n---\n\n**Источники:**\n${deepSearch.sources.map((s) => `${s.index}. [${s.title}](${s.url})`).join("\n")}`
      : "";
    displayMessages.push({ id: "deepsearch-report", role: "assistant", content: deepSearch.report + sourcesText, timestamp: new Date() });
  }

  const isDeepSearchActive = ["searching", "clarifying", "generating_queries", "analyzing"].includes(deepSearch.phase);

  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-background"
      onTouchStart={isMobile && sidebarOpen ? handleTouchStart : undefined}
      onTouchEnd={isMobile && sidebarOpen ? handleTouchEnd : undefined}
    >
      {/* Mobile sidebar overlay */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        ref={sidebarRef}
        className={`
          flex-shrink-0 transition-all duration-300 border-r border-sidebar-border
          ${isMobile
            ? `fixed inset-y-0 left-0 z-50 ${sidebarOpen ? "translate-x-0 w-[85vw] max-w-[320px]" : "-translate-x-full w-[85vw] max-w-[320px]"} transition-transform`
            : `${sidebarOpen ? "w-64" : "w-0"} overflow-hidden`
          }
        `}
      >
        <div className={isMobile ? "h-full" : "h-full w-64"}>
          {isMobile && sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(false)}
              className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-muted-foreground btn-interactive transition-all"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <ChatSidebar
            chats={chats} activeChatId={activeChatId} userEmail={user?.email}
            onNewChat={handleNewChat} onSelectChat={handleSelectChat}
            onDeleteChat={deleteChat} onRenameChat={renameChat}
          />
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0 relative">

        {/* Desktop header */}
        {!isMobile && (
          <header className="flex items-center justify-between border-b border-border px-3 py-2 gap-2 flex-shrink-0 animate-fade-in">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="btn-interactive rounded-lg p-2 text-muted-foreground transition-all flex-shrink-0"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <ModelSelector selectedModel={selectedModel} onSelect={handleModelSelect} />
              </div>
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                onClick={() => setThinkingEnabled(!thinkingEnabled)}
                className={`rounded-lg p-2 transition-all ${thinkingEnabled ? "bg-interactive/15 text-interactive" : "btn-interactive text-muted-foreground"}`}
                title={thinkingEnabled ? "Thinking mode включён" : "Включить thinking mode"}
              >
                <Brain className="h-5 w-5" />
              </button>
              <button
                onClick={() => setSettingsOpen(true)}
                className="btn-interactive rounded-lg p-2 text-muted-foreground transition-all"
                title="Настройки"
              >
                <Settings className="h-5 w-5" />
              </button>
            </div>
          </header>
        )}

        {/* Mobile floating header */}
        {isMobile && (
          <div
            className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-1.5 pointer-events-none"
            style={{ paddingTop: "max(8px, env(safe-area-inset-top, 8px))" }}
          >
            <button
              onClick={() => setSidebarOpen(true)}
              className="pointer-events-auto btn-interactive rounded-xl p-2.5 text-muted-foreground transition-all"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="pointer-events-auto">
              <ModelSelector selectedModel={selectedModel} onSelect={handleModelSelect} />
            </div>

            <div className="flex items-center gap-0.5 pointer-events-auto">
              <button
                onClick={() => setThinkingEnabled(!thinkingEnabled)}
                className={`rounded-xl p-2.5 transition-all active:scale-90 ${thinkingEnabled ? "bg-interactive/15 text-interactive" : "btn-interactive text-muted-foreground"}`}
              >
                <Brain className="h-5 w-5" />
              </button>
              <button
                onClick={handleNewChat}
                className="btn-interactive rounded-xl p-2.5 text-muted-foreground transition-all"
                title="Новый чат"
              >
                <SquarePen className="h-5 w-5" />
              </button>
              <button
                onClick={() => setSettingsOpen(true)}
                className="btn-interactive rounded-xl p-2.5 text-muted-foreground transition-all"
                title="Настройки"
              >
                <Settings className="h-5 w-5" />
              </button>
            </div>
          </div>
        )}

        {/* Chat content */}
        <div className="flex flex-1 flex-col overflow-hidden min-h-0 relative">
          {displayMessages.length === 0 ? (
            <EmptyState onSuggestionClick={handleSuggestionClick} isMobile={isMobile} />
          ) : (
            <div
              ref={scrollContainerRef}
              className={`flex-1 overflow-y-auto px-3 sm:px-4 scrollbar-thin ${isMobile ? "pt-16" : ""}`}
              style={isMobile ? { paddingTop: "max(64px, calc(env(safe-area-inset-top, 0px) + 56px))" } : undefined}
            >
              <div className="mx-auto max-w-3xl pb-2">
                {displayMessages.map((msg, i) => (
                  <div key={msg.id} className="group">
                    <MessageBubble
                      message={msg}
                      ttsVoice={ttsVoice}
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

          {/* Scroll to bottom button */}
          {showScrollBtn && displayMessages.length > 0 && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-[calc(100px+env(safe-area-inset-bottom,0px))] left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full border border-border bg-background/90 backdrop-blur-sm px-3 py-1.5 text-xs text-muted-foreground shadow-lg btn-interactive transition-all animate-pop"
            >
              <ChevronDown className="h-3.5 w-3.5" />
              <span>Вниз</span>
            </button>
          )}

          <DeepSearchPanel deepSearch={deepSearch} />

          <ChatInput
            onSend={handleSendWithDeepSearchCheck}
            isStreaming={isStreaming || isDeepSearchActive}
            onStop={isDeepSearchActive ? stopSearch : stopStreaming}
            deepSearchUsed={deepSearch.used}
            onDeepSearch={handleDeepSearch}
          />
        </div>
      </div>

      {/* Settings panel */}
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        isDark={isDark}
        onToggleTheme={toggleTheme}
        ttsVoice={ttsVoice}
        onVoiceChange={handleVoiceChange}
        onSignOut={signOut}
        userEmail={user?.email}
        soundsEnabled={soundsEnabled}
        onToggleSounds={toggleSounds}
      />
    </div>
  );
};

export default Index;
