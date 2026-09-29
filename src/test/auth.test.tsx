import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

const activeUser = { id: "user-1" } as User;

function renderAuth(user: User | null = null, initialPath = "/auth") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<div data-testid="home-page">Главная</div>} />
        <Route path="/auth" element={<Auth user={user} authLoading={false} />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Auth page (email authorization closed)", () => {
  it("shows notice that email authorization is closed and hides email/password inputs", () => {
    renderAuth();
    expect(screen.getByText(/авторизация через почту закрыта/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("you@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Войти" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Регистрация" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /на главную/i })).toHaveAttribute("href", "/");
  });

  it("keeps email recovery/reset disabled even when recovery query params are present", () => {
    renderAuth(null, "/auth?mode=reset");
    expect(screen.getByText(/авторизация через почту закрыта/i)).toBeInTheDocument();
    expect(authMocks.signInWithPassword).not.toHaveBeenCalled();
    expect(authMocks.signUp).not.toHaveBeenCalled();
    expect(authMocks.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(authMocks.updateUser).not.toHaveBeenCalled();
  });

  it("redirects already authenticated users to the root page", () => {
    renderAuth(activeUser);
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });
});
