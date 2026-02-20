import { useState, useRef, useEffect, useCallback } from "react";
import { Menu, Share, Moon, Sun, LogOut, Brain } from "lucide-react";
import { ChatSidebar } from "@/components/ChatSidebar";
import { ChatInput } from "@/components/ChatInput";
import { MessageBubble } from "@/components/MessageBubble";
import { EmptyState } from "@/components/EmptyState";
import { ModelSelector } from "@/components/ModelSelector";
import { useChat } from "@/hooks/useChat";
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

  const { isDark, toggle: toggleTheme } = useTheme();
  const { user, signOut } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeChat?.messages]);

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

  const messages = activeChat?.messages || [];

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
          {messages.length === 0 ? (
            <EmptyState onSuggestionClick={handleSuggestionClick} />
          ) : (
            <div className="flex-1 overflow-y-auto px-4 scrollbar-thin">
              <div className="mx-auto max-w-3xl">
                {messages.map((msg, i) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isStreaming={isStreaming && i === messages.length - 1 && msg.role === "assistant"}
                  />
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>
          )}

          {/* Input */}
          <ChatInput onSend={sendMessage} isStreaming={isStreaming} onStop={stopStreaming} />
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
