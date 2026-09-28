import { useEffect, useRef, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles, Loader2, Eye, EyeOff, Mail, Lock, ShieldAlert, Timer } from "lucide-react";
import { toast } from "sonner";

const MAX_ATTEMPTS = 3;
const LOCKOUT_SECONDS = 10;
const STORAGE_KEY = "auth_rate_limit";

type AuthMode = "login" | "signup" | "recovery" | "reset";

interface RateLimitState {
  attempts: number;
  lockedUntil: number | null;
}

interface AuthProps {
  user: User | null;
  authLoading: boolean;
}

const emptyRateLimit = (): RateLimitState => ({ attempts: 0, lockedUntil: null });

const loadState = (): RateLimitState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyRateLimit();
    const parsed = JSON.parse(raw) as Partial<RateLimitState>;
    if (
      typeof parsed.attempts !== "number" ||
      (parsed.lockedUntil !== null && typeof parsed.lockedUntil !== "number")
    ) {
      return emptyRateLimit();
    }
    return { attempts: parsed.attempts, lockedUntil: parsed.lockedUntil ?? null };
  } catch {
    return emptyRateLimit();
  }
};

const saveState = (state: RateLimitState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable in private browsing; auth itself still works.
  }
};

function initialAuthMode(): AuthMode {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return query.get("mode") === "reset" || query.get("type") === "recovery" || hash.get("type") === "recovery"
    ? "reset"
    : "login";
}

function authErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Произошла ошибка. Попробуйте ещё раз.";
}

const Auth = ({ user, authLoading }: AuthProps) => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>(initialAuthMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const tickRef = useRef<number | null>(null);

  const isLogin = mode === "login";
  const isLocked = isLogin && lockedUntil !== null && secondsLeft > 0;
  const showPasswordField = mode !== "recovery" && !(mode === "reset" && authLoading);

  useEffect(() => {
    if (authLoading || !user || mode === "reset") return;
    navigate("/", { replace: true });
  }, [authLoading, mode, navigate, user]);

  useEffect(() => {
    const state = loadState();
    setAttempts(state.attempts);
    if (state.lockedUntil && state.lockedUntil > Date.now()) {
      setLockedUntil(state.lockedUntil);
    } else if (state.lockedUntil) {
      saveState(emptyRateLimit());
      setAttempts(0);
    }
  }, []);

  useEffect(() => {
    if (!lockedUntil) {
      setSecondsLeft(0);
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      return;
    }

    const update = () => {
      const left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        setLockedUntil(null);
        setAttempts(0);
        saveState(emptyRateLimit());
        if (tickRef.current !== null) window.clearInterval(tickRef.current);
      }
    };

    update();
    tickRef.current = window.setInterval(update, 250);
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
    };
  }, [lockedUntil]);

  const registerFailure = () => {
    const next = attempts + 1;
    if (next >= MAX_ATTEMPTS) {
      const until = Date.now() + LOCKOUT_SECONDS * 1000;
      setAttempts(next);
      setLockedUntil(until);
      saveState({ attempts: next, lockedUntil: until });
      toast.error("Слишком много неверных попыток. Повторите вход через несколько секунд.");
      return;
    }

    setAttempts(next);
    saveState({ attempts: next, lockedUntil: null });
    toast.error(`Неверный email или пароль. Осталось попыток: ${MAX_ATTEMPTS - next}`);
  };

  const resetRateLimit = () => {
    setAttempts(0);
    setLockedUntil(null);
    saveState(emptyRateLimit());
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLocked || loading) return;

    if (mode === "reset" && !user) {
      toast.error("Ссылка восстановления недействительна или истекла. Запросите новую.");
      setMode("recovery");
      return;
    }

    setLoading(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) {
          if (error.message.includes("Invalid login credentials")) registerFailure();
          else toast.error(error.message || "Не удалось войти");
          return;
        }
        resetRateLimit();
        navigate("/", { replace: true });
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) {
          toast.error(error.message || "Не удалось создать аккаунт");
          return;
        }
        resetRateLimit();
        setPassword("");
        setMode("login");
        toast.success("Если адрес можно зарегистрировать, на него отправлено письмо для подтверждения.");
      } else if (mode === "recovery") {
        const redirectTo = new URL("/auth?mode=reset", window.location.origin).toString();
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
        if (error) {
          toast.error(error.message || "Не удалось отправить письмо");
          return;
        }
        setMode("login");
        toast.success("Если аккаунт с таким адресом существует, на почту отправлена ссылка для сброса пароля.");
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
          toast.error(error.message || "Не удалось обновить пароль");
          return;
        }
        setPassword("");
        toast.success("Пароль обновлён.");
        navigate("/", { replace: true });
      }
    } catch (error: unknown) {
      toast.error(authErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const title = mode === "signup"
    ? "Создайте аккаунт"
    : mode === "recovery"
      ? "Восстановление пароля"
      : mode === "reset"
        ? "Новый пароль"
        : "Добро пожаловать";

  const submitLabel = mode === "signup"
    ? "Создать аккаунт"
    : mode === "recovery"
      ? "Отправить ссылку"
      : mode === "reset"
        ? "Сохранить новый пароль"
        : "Войти";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm animate-fade-in">
        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          <div className="mb-8 flex flex-col items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-sm transition-transform hover:scale-105">
              <Sparkles className="h-7 w-7 text-primary-foreground" />
            </div>
            <div className="text-center">
              <h1 className="text-xl font-bold text-foreground">HikkoGPT</h1>
              <p className="mt-1 text-sm text-muted-foreground">{title}</p>
            </div>
          </div>

          {(mode === "login" || mode === "signup") && (
            <div className="mb-6 flex rounded-xl bg-secondary p-1">
              <button
                type="button"
                onClick={() => { setMode("login"); setPassword(""); }}
                disabled={isLocked || loading}
                className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all active:scale-95 disabled:opacity-50 ${isLogin ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-primary/10 hover:text-primary"}`}
              >
                Войти
              </button>
              <button
                type="button"
                onClick={() => { setMode("signup"); setPassword(""); }}
                disabled={loading}
                className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all active:scale-95 ${mode === "signup" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-primary/10 hover:text-primary"}`}
              >
                Регистрация
              </button>
            </div>
          )}

          {isLocked && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 animate-fade-in">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="flex-1 text-xs">
                <p className="font-medium text-destructive">Слишком много неверных попыток входа</p>
                <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                  <Timer className="h-3 w-3" />
                  <span>Повторите через {secondsLeft} сек.</span>
                </div>
              </div>
            </div>
          )}

          {mode === "reset" && !authLoading && !user ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-muted-foreground">Ссылка для смены пароля недействительна или срок её действия истёк.</p>
              <button
                type="button"
                onClick={() => setMode("recovery")}
                className="w-full rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Запросить новую ссылку
              </button>
              <button type="button" onClick={() => setMode("login")} className="text-sm text-muted-foreground hover:text-foreground">
                Вернуться ко входу
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  disabled={isLocked || loading || mode === "reset"}
                  className="w-full rounded-xl border border-border bg-background py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50"
                  placeholder="you@example.com"
                />
              </div>

              {showPasswordField && (
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={6}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    disabled={isLocked || loading}
                    className="w-full rounded-xl border border-border bg-background py-2.5 pl-10 pr-10 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50"
                    placeholder={mode === "login" ? "Пароль" : "Минимум 6 символов"}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    disabled={isLocked || loading}
                    aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              )}

              {isLogin && attempts > 0 && !isLocked && (
                <p className="text-center text-xs text-muted-foreground animate-fade-in">
                  Осталось попыток: <span className="font-semibold text-foreground">{MAX_ATTEMPTS - attempts}</span>
                </p>
              )}

              <button
                type="submit"
                disabled={loading || isLocked || (mode === "reset" && !user)}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {isLocked ? `Подождите ${secondsLeft}с` : submitLabel}
              </button>

              {isLogin && (
                <button type="button" onClick={() => setMode("recovery")} className="w-full text-sm text-muted-foreground hover:text-primary">
                  Забыли пароль?
                </button>
              )}

              {(mode === "recovery" || mode === "reset") && (
                <button type="button" onClick={() => { setMode("login"); setPassword(""); }} className="w-full text-sm text-muted-foreground hover:text-primary">
                  Вернуться ко входу
                </button>
              )}
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Продолжая, вы соглашаетесь с условиями использования
        </p>
      </div>
    </div>
  );
};

export default Auth;
