import { X, Volume2, Moon, Sun, LogOut, Bell, BellOff } from "lucide-react";

const TTS_VOICES = [
  { id: "Aoede", label: "Aoede", desc: "Женский голос" },
  { id: "Charon", label: "Charon", desc: "Мужской голос" },
  { id: "Fenrir", label: "Fenrir", desc: "Мужской чёткий" },
  { id: "Kore", label: "Kore", desc: "Женский тёплый" },
  { id: "Puck", label: "Puck", desc: "Нейтральный" },
  { id: "Leda", label: "Leda", desc: "Женский спокойный" },
];

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
  ttsVoice: string;
  onVoiceChange: (v: string) => void;
  onSignOut: () => void;
  userEmail?: string;
  soundsEnabled?: boolean;
  onToggleSounds?: () => void;
}

export function SettingsPanel({ open, onClose, isDark, onToggleTheme, ttsVoice, onVoiceChange, onSignOut, userEmail, soundsEnabled = true, onToggleSounds }: SettingsPanelProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center animate-fade-in">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-sm rounded-t-3xl sm:rounded-2xl bg-card border border-border shadow-2xl p-5 mx-0 sm:mx-4 animate-slide-up">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-foreground">Настройки</h2>
          <button onClick={onClose} className="btn-interactive rounded-full p-1.5 text-muted-foreground transition-all">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* User */}
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-secondary/50 p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-interactive text-interactive-foreground text-sm font-bold">
            {userEmail?.[0]?.toUpperCase() || "U"}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">{userEmail || "User"}</p>
            <p className="text-xs text-muted-foreground">Аккаунт</p>
          </div>
        </div>

        {/* Theme */}
        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Тема</p>
          <button
            onClick={onToggleTheme}
            className="flex w-full items-center justify-between rounded-xl bg-secondary/50 px-4 py-3 text-sm text-foreground btn-interactive transition-all"
          >
            <span>{isDark ? "Тёмная тема" : "Светлая тема"}</span>
            {isDark ? <Moon className="h-4 w-4 text-muted-foreground" /> : <Sun className="h-4 w-4 text-muted-foreground" />}
          </button>
        </div>

        {/* Sounds */}
        {onToggleSounds && (
          <div className="mb-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Звуковые эффекты</p>
            <button
              onClick={onToggleSounds}
              className="flex w-full items-center justify-between rounded-xl bg-secondary/50 px-4 py-3 text-sm text-foreground btn-interactive transition-all"
            >
              <span>{soundsEnabled ? "Звуки включены" : "Звуки выключены"}</span>
              {soundsEnabled ? <Bell className="h-4 w-4 text-interactive" /> : <BellOff className="h-4 w-4 text-muted-foreground" />}
            </button>
          </div>
        )}

        {/* TTS Voice */}
        <div className="mb-5">
          <div className="mb-2 flex items-center gap-1.5">
            <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Голос озвучки</p>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {TTS_VOICES.map((v) => (
              <button
                key={v.id}
                onClick={() => onVoiceChange(v.id)}
                className={`rounded-xl px-3 py-2.5 text-left transition-all active:scale-[0.97] ${
                  ttsVoice === v.id
                    ? "bg-interactive text-interactive-foreground ring-2 ring-interactive/30 shadow-sm shadow-interactive/10"
                    : "bg-secondary/50 text-foreground hover:bg-secondary"
                }`}
              >
                <p className="text-sm font-medium">{v.label}</p>
                <p className={`text-xs mt-0.5 ${ttsVoice === v.id ? "text-interactive-foreground/70" : "text-muted-foreground"}`}>{v.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={onSignOut}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive hover:bg-destructive/20 transition-all active:scale-[0.98]"
        >
          <LogOut className="h-4 w-4" />
          Выйти из аккаунта
        </button>
      </div>
    </div>
  );
}
