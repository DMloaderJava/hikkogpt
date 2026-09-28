import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import Auth from "@/pages/Auth";

const authMocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: authMocks },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const recoveryUser = { id: "user-1" } as User;

function renderAuth(user: User | null = null) {
  return render(
    <MemoryRouter>
      <Auth user={user} authLoading={false} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/auth");
  authMocks.signInWithPassword.mockResolvedValue({ error: null });
  authMocks.signUp.mockResolvedValue({ error: null, data: { session: null } });
  authMocks.resetPasswordForEmail.mockResolvedValue({ error: null });
  authMocks.updateUser.mockResolvedValue({ error: null });
});

describe("Supabase Auth recovery", () => {
  it("sends a password reset email with an explicit recovery callback URL", async () => {
    renderAuth();
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "reader@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Забыли пароль?" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить ссылку" }));

    await waitFor(() => {
      expect(authMocks.resetPasswordForEmail).toHaveBeenCalledWith("reader@example.com", {
        redirectTo: `${window.location.origin}/auth?mode=reset`,
      });
    });
  });

  it("allows a recovery session to set a new password instead of redirecting to the app root", async () => {
    window.history.replaceState({}, "", "/auth?mode=reset");
    renderAuth(recoveryUser);
    fireEvent.change(screen.getByPlaceholderText("Минимум 6 символов"), {
      target: { value: "new-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить новый пароль" }));

    await waitFor(() => {
      expect(authMocks.updateUser).toHaveBeenCalledWith({ password: "new-secure-password" });
    });
  });

  it("offers a fresh reset link when a recovery URL has no valid session", () => {
    window.history.replaceState({}, "", "/auth?mode=reset");
    renderAuth();
    expect(screen.getByText(/ссылка для смены пароля недействительна/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Запросить новую ссылку" }));
    expect(screen.getByRole("button", { name: "Отправить ссылку" })).toBeInTheDocument();
  });
});
