import { useEffect } from "react";
import type { User } from "@supabase/supabase-js";
import { Link, useNavigate } from "react-router-dom";
import { Sparkles, ShieldAlert, ArrowLeft } from "lucide-react";

interface AuthProps {
  user: User | null;
  authLoading: boolean;
}

const Auth = ({ user, authLoading }: AuthProps) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (authLoading || !user) return;
    navigate("/", { replace: true });
  }, [authLoading, navigate, user]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm animate-fade-in">
        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          <div className="mb-6 flex flex-col items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-sm transition-transform hover:scale-105">
              <Sparkles className="h-7 w-7 text-primary-foreground" />
            </div>
            <div className="text-center">
              <h1 className="text-xl font-bold text-foreground">HikkoGPT</h1>
              <p className="mt-1 text-sm text-muted-foreground">Авторизация закрыта</p>
            </div>
          </div>

          <div
            role="status"
            className="mb-6 flex items-start gap-3 rounded-xl border border-border bg-secondary/50 p-4"
          >
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="text-sm font-medium text-foreground">
                Авторизация через почту закрыта
              </p>
              <p>
                Вход, регистрация и восстановление пароля по электронной почте в данный момент отключены.
              </p>
            </div>
          </div>

          <Link
            to="/"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 active:scale-95"
          >
            <ArrowLeft className="h-4 w-4" />
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Auth;
