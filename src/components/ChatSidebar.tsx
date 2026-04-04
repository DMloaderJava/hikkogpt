import { useState } from "react";
import { Plus, MessageSquare, Trash2, Pencil, Check, X, Sparkles } from "lucide-react";
import type { Chat } from "@/hooks/useChat";

interface ChatSidebarProps {
  chats: Chat[];
  activeChatId: string | null;
  userEmail?: string;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
}

function groupChatsByDate(chats: Chat[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const week = new Date(today.getTime() - 7 * 86400000);

  const groups: { label: string; chats: Chat[] }[] = [
    { label: "Сегодня", chats: [] },
    { label: "Вчера", chats: [] },
    { label: "Последние 7 дней", chats: [] },
    { label: "Ранее", chats: [] },
  ];

  chats.forEach((chat) => {
    const d = new Date(chat.updatedAt);
    if (d >= today) groups[0].chats.push(chat);
    else if (d >= yesterday) groups[1].chats.push(chat);
    else if (d >= week) groups[2].chats.push(chat);
    else groups[3].chats.push(chat);
  });

  return groups.filter((g) => g.chats.length > 0);
}

export function ChatSidebar({
  chats,
  activeChatId,
  userEmail,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  onRenameChat,
}: ChatSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const groups = groupChatsByDate(chats);

  const startEditing = (chat: Chat) => {
    setEditingId(chat.id);
    setEditTitle(chat.title);
  };

  const confirmEdit = () => {
    if (editingId && editTitle.trim()) {
      onRenameChat(editingId, editTitle.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Header */}
      <div className="flex items-center justify-between p-3 animate-fade-in">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-interactive" />
          <span className="text-sm font-semibold">HikkoGPT</span>
        </div>
        <button
          onClick={onNewChat}
          className="btn-interactive rounded-md p-1.5 transition-all text-sidebar-foreground"
          title="Новый чат"
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto px-2 scrollbar-thin">
        {groups.map((group) => (
          <div key={group.label} className="mb-3">
            <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {group.label}
            </p>
            {group.chats.map((chat) => (
              <div
                key={chat.id}
                className={`group flex items-center gap-2 rounded-lg px-2 py-2 text-sm cursor-pointer transition-all duration-150 ${
                  chat.id === activeChatId
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent/50"
                }`}
                onClick={() => onSelectChat(chat.id)}
              >
                <MessageSquare className="h-4 w-4 flex-shrink-0 opacity-60" />
                {editingId === chat.id ? (
                  <div className="flex flex-1 items-center gap-1">
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && confirmEdit()}
                      className="flex-1 rounded bg-input px-1 py-0.5 text-sm text-foreground outline-none"
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button onClick={(e) => { e.stopPropagation(); confirmEdit(); }} className="btn-interactive rounded p-0.5">
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setEditingId(null); }} className="btn-interactive rounded p-0.5">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1 truncate">{chat.title}</span>
                    <div className="hidden items-center gap-0.5 group-hover:flex">
                      <button
                        onClick={(e) => { e.stopPropagation(); startEditing(chat); }}
                        className="btn-interactive rounded p-1 transition-all"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteChat(chat.id); }}
                        className="rounded p-1 hover:bg-destructive/20 hover:text-destructive transition-all active:scale-90"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}

        {chats.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            Нет сохранённых чатов
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-sidebar-accent cursor-pointer transition-all">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-interactive text-interactive-foreground text-xs font-medium">
            {userEmail?.[0]?.toUpperCase() || "U"}
          </div>
          <span className="text-sm truncate">{userEmail || "User"}</span>
        </div>
      </div>
    </div>
  );
}
