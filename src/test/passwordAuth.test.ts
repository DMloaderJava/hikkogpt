import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));

import {
  EMAIL_LINK_DISABLED_MESSAGE,
  isEmailNotConfirmedMessage,
  mapAuthError,
  signInWithoutEmailLink,
  signUpWithoutEmailLink,
  type PasswordAuthClient,
} from "@/lib/passwordAuth";
import { isExistingUserError, parseRegisterInput } from "../../supabase/functions/auth-register/logic";

function client(partial: Partial<PasswordAuthClient> & { signUp?: ReturnType<typeof vi.fn> }): PasswordAuthClient & {
  signUp: ReturnType<typeof vi.fn>;
} {
  return {
    signIn: vi.fn(async () => ({ errorMessage: null, hasSession: true })),
    signUp: vi.fn(),
    ensureAccount: vi.fn(async () => ({ ok: true as const, created: true })),
    ...partial,
  };
}

describe("email confirmation links are disabled", () => {
  it("does not tell the user to check their inbox", () => {
    const authPage = readFileSync(resolve(process.cwd(), "src/pages/Auth.tsx"), "utf8");
    expect(authPage).not.toMatch(/Проверьте почту/);
    expect(authPage).not.toMatch(/emailRedirectTo/);
    expect(authPage).not.toMatch(/resetPasswordForEmail/);
    expect(authPage).not.toMatch(/signUp\(/);
    expect(mapAuthError("Email not confirmed")).toBe(EMAIL_LINK_DISABLED_MESSAGE);
    expect(mapAuthError("Email not confirmed")).not.toMatch(/Проверьте почту/);
    expect(isEmailNotConfirmedMessage("Email not confirmed")).toBe(true);
  });

  it("registers through the no-email function and does not call public signUp", async () => {
    const auth = client({
      ensureAccount: vi.fn(async () => ({ ok: true as const, created: true })),
      signIn: vi.fn(async () => ({ errorMessage: null, hasSession: true })),
    });

    const result = await signUpWithoutEmailLink(auth, "user@example.com", "secret1");

    expect(result).toEqual({ ok: true });
    expect(auth.ensureAccount).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "secret1",
      action: "register",
    });
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(auth.signIn).toHaveBeenCalledOnce();
  });

  it("confirms an existing unconfirmed account and signs in without a mail link", async () => {
    const signIn = vi
      .fn()
      .mockResolvedValueOnce({ errorMessage: "Email not confirmed", hasSession: false })
      .mockResolvedValueOnce({ errorMessage: null, hasSession: true });
    const auth = client({
      signIn,
      ensureAccount: vi.fn(async () => ({ ok: true as const, created: false })),
    });

    const result = await signInWithoutEmailLink(auth, "user@example.com", "secret1");

    expect(result).toEqual({ ok: true });
    expect(auth.ensureAccount).toHaveBeenCalledWith({
      email: "user@example.com",
      action: "confirm",
    });
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to public signUp when the confirm function rejects the password", async () => {
    const auth = client({
      ensureAccount: vi.fn(async () => ({
        ok: false as const,
        unavailable: false,
        message: "Пароль должен быть минимум 6 символов",
      })),
    });

    const result = await signUpWithoutEmailLink(auth, "user@example.com", "secret1");

    expect(result.ok).toBe(false);
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it("does not call public signUp when the no-email function is missing", async () => {
    const auth = client({
      ensureAccount: vi.fn(async () => ({
        ok: false as const,
        unavailable: true,
        message: "missing",
      })),
    });

    const result = await signUpWithoutEmailLink(auth, "user@example.com", "secret1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toMatch(/Проверьте почту/);
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });
});

describe("auth-register input", () => {
  it("accepts register and strips the password from confirm", () => {
    expect(parseRegisterInput({ email: " User@Example.com ", password: "secret1" })).toEqual({
      ok: true,
      email: "user@example.com",
      password: "secret1",
      action: "register",
    });
    expect(parseRegisterInput({ email: "user@example.com", password: "nope", action: "confirm" })).toEqual({
      ok: true,
      email: "user@example.com",
      password: "",
      action: "confirm",
    });
  });

  it("rejects a short password and an unknown action", () => {
    expect(parseRegisterInput({ email: "user@example.com", password: "123" }).ok).toBe(false);
    expect(parseRegisterInput({ email: "user@example.com", password: "secret1", action: "invite" })).toMatchObject({
      ok: false,
      error: "invalid_action",
    });
  });

  it("recognizes an existing GoTrue user without treating it as a new signup", () => {
    expect(isExistingUserError("A user with this email address has already been registered", "email_exists")).toBe(true);
    expect(isExistingUserError("Password should be at least 6 characters", "weak_password")).toBe(false);
  });

  it("deploys auth-register without gateway JWT, so signup can run before a session exists", () => {
    const config = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8");
    const section = config.match(/\[functions\.auth-register\][\s\S]*?(?=\n\[|$)/);
    expect(section?.[0]).toMatch(/verify_jwt\s*=\s*false/);
  });
});
