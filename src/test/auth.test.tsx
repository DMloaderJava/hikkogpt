import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import Auth from "@/pages/Auth";

const authFlow = vi.hoisted(() => ({
  signInWithoutEmailLink: vi.fn(),
  signUpWithoutEmailLink: vi.fn(),
  createSupabasePasswordAuthClient: vi.fn(() => ({})),
  mapAuthError: (message: string) => message,
}));

const authMocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/lib/passwordAuth", () => authFlow);
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: authMocks },
}));

const activeUser = { id: "user-1" } as User;

function renderAuth(user: User | null = null, initialPath = "/auth") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<div data-testid="home-page">Главная</div>} />
        <Route path="/auth" element={<Auth user={user} authLoading={false} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authFlow.signInWithoutEmailLink.mockResolvedValue({ ok: true });
  authFlow.signUpWithoutEmailLink.mockResolvedValue({ ok: true });
});

describe("Auth page without email-link verification", () => {
  it("does not show a check-your-email step and keeps email/password login", () => {
    renderAuth();
    expect(screen.queryByText(/проверьте почту/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/авторизация через почту закрыта/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Войти" })).toBeInTheDocument();
  });

  it("signs in without calling the public signup or reset mailers", async () => {
    renderAuth();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "secret1" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => expect(authFlow.signInWithoutEmailLink).toHaveBeenCalled());
    expect(authMocks.signInWithPassword).not.toHaveBeenCalled();
    expect(authMocks.signUp).not.toHaveBeenCalled();
    expect(authMocks.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(screen.queryByText(/проверьте почту/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });

  it("registers through the no-email helper and never asks to open a confirmation link", async () => {
    renderAuth();
    fireEvent.click(screen.getByRole("button", { name: "Регистрация" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Пароль/), { target: { value: "secret1" } });
    fireEvent.change(screen.getByLabelText("Подтвердите пароль"), { target: { value: "secret1" } });
    fireEvent.click(screen.getByRole("button", { name: "Зарегистрироваться" }));

    await waitFor(() =>
      expect(authFlow.signUpWithoutEmailLink).toHaveBeenCalledWith(expect.anything(), "user@example.com", "secret1"),
    );
    expect(authMocks.signUp).not.toHaveBeenCalled();
    expect(screen.queryByText(/проверьте почту/i)).not.toBeInTheDocument();
  });

  it("does not send a recovery email just because recovery query params are present", () => {
    renderAuth(null, "/auth?mode=reset");
    expect(authMocks.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(authMocks.updateUser).not.toHaveBeenCalled();
    expect(screen.queryByText(/проверьте почту/i)).not.toBeInTheDocument();
  });

  it("redirects already authenticated users to the root page", () => {
    renderAuth(activeUser);
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });
});
