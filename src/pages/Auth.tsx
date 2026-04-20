import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles, Loader2, Eye, EyeOff, Mail, Lock, ShieldAlert, Timer } from "lucide-react";
import { toast } from "sonner";

const MAX_ATTEMPTS = 3;
const LOCKOUT_SECONDS = 10;
const STORAGE_KEY = "auth_rate_limit";

interface RateLimitState {
  attempts: number;
  lockedUntil: number | null;
}

const loadState = (): RateLimitState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { attempts: 0, lockedUntil: null };
    return JSON.parse(raw);
  } catch {
    return { attempts: 0, lockedUntil: null };
  }
};

const saveState = (state: RateLimitState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
};

const Auth = () => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const tickRef = useRef<number | null>(null);

  // Hydrate rate-limit state from localStorage
  useEffect(() => {
    const state = loadState();
    setAttempts(state.attempts);
    if (state.lockedUntil && state.lockedUntil > Date.now()) {
      setLockedUntil(state.lockedUntil);
    } else if (state.lockedUntil) {
      // Lockout expired — reset counter
      const fresh = { attempts: 0, lockedUntil: null };
      saveState(fresh);
      setAttempts(0);
    }
  }, []);

  // Countdown timer
  useEffect(() => {
    if (!lockedUntil) {
      setSecondsLeft(0);
      if (tickRef.current) window.clearInterval(tickRef.current);
      return;
    }

    const update = () => {
      const left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        setLockedUntil(null);
        setAttempts(0);
        saveState({ attempts: 0, lockedUntil: null });
        if (tickRef.current) window.clearInterval(tickRef.current);
      }
    };

    update();
    tickRef.current = window.setInterval(update, 250);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [lockedUntil]);

  const isLocked = lockedUntil !== null && secondsLeft > 0;

  const registerFailure = () => {
    const next = attempts + 1;
    if (next >= MAX_ATTEMPTS) {
      const until = Date.now() + LOCKOUT_SECONDS * 1000;
      setAttempts(next);
      setLockedUntil(until);
      saveState({ attempts: next, lockedUntil: until });
      toast.error("Создайте новый аккаунт или введите пароль чуть позже", {
        duration: 5000,
      });
    } else {
      setAttempts(next);
      saveState({ attempts: next, lockedUntil: null });
      toast.error(`Неверный email или пароль. Осталось попыток: ${MAX_ATTEMPTS - next}`);
    }
  };

  const resetRateLimit = () => {
    setAttempts(0);
    setLockedUntil(null);
    saveState({ attempts: 0, lockedUntil: null });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLocked) return;
    setLoading(true);

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          if (error.message?.includes("Invalid login credentials")) {
            registerFailure();
          } else {
            toast.error(error.message || "Произошла ошибка");
          }
          return;
        }
        resetRateLimit();
        navigate("/");
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) {
          const msg = error.message?.includes("already registered")
            ? "Этот email уже зарегистрирован"
            : error.message || "Произошла ошибка";
          toast.error(msg);
          return;
        }
        toast.success("Аккаунт создан! Проверьте почту для подтверждения.");
        resetRateLimit();
      }
    } catch (error: any) {
      toast.error(error.message || "Произошла ошибка");
    } finally {
      setLoading(false);
    }
  };

  const switchToSignup = () => {
    setIsLogin(false);
    setPassword("");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      {/* Background gradient */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm animate-fade-in">
        {/* Card */}
        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          {/* Logo */}
          <div className="mb-8 flex flex-col items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-sm transition-transform hover:scale-105">
              <Sparkles className="h-7 w-7 text-primary-foreground" />
            </div>
            <div className="text-center">
              <h1 className="text-xl font-bold text-foreground">HikkoGPT</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {isLogin ? "Добро пожаловать" : "Создайте аккаунт"}
              </p>
            </div>
          </div>

          {/* Toggle tabs */}
          <div className="mb-6 flex rounded-xl bg-secondary p-1">
            <button
              onClick={() => setIsLogin(true)}
              disabled={isLocked}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all active:scale-95 disabled:opacity-50 ${
                isLogin
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-primary/10 hover:text-primary"
              }`}
            >
              Войти
            </button>
            <button
              onClick={() => setIsLogin(false)}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all active:scale-95 ${
                !isLogin
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-primary/10 hover:text-primary"
              }`}
            >
              Регистрация
            </button>
          </div>

          {/* Lockout banner */}
          {isLocked && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 animate-fade-in">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="flex-1 text-xs">
                <p className="font-medium text-destructive">
                  Создайте новый аккаунт или введите пароль чуть позже
                </p>
                <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                  <Timer className="h-3 w-3" />
                  <span>Повторите через {secondsLeft} сек.</span>
                </div>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLocked}
                className="w-full rounded-xl border border-border bg-background py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50"
                placeholder="you@example.com"
              />
            </div>

            {/* Password */}
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                disabled={isLocked}
                className="w-full rounded-xl border border-border bg-background py-2.5 pl-10 pr-10 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50"
                placeholder="Минимум 6 символов"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                disabled={isLocked}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {/* Attempts indicator (only on login, before lockout) */}
            {isLogin && attempts > 0 && !isLocked && (
              <p className="text-center text-xs text-muted-foreground animate-fade-in">
                Осталось попыток:{" "}
                <span className="font-semibold text-foreground">
                  {MAX_ATTEMPTS - attempts}
                </span>
              </p>
            )}

            <button
              type="submit"
              disabled={loading || isLocked}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {isLocked
                ? `Подождите ${secondsLeft}с`
                : isLogin
                ? "Войти"
                : "Создать аккаунт"}
            </button>

            {/* Secondary action when locked */}
            {isLocked && isLogin && (
              <button
                type="button"
                onClick={switchToSignup}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background py-2.5 text-sm font-medium text-foreground transition-all hover:border-primary hover:bg-primary/10 hover:text-primary active:scale-95 animate-fade-in"
              >
                Создать новый аккаунт
              </button>
            )}
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Продолжая, вы соглашаетесь с условиями использования
        </p>
      </div>
    </div>
  );
};

export default Auth;
