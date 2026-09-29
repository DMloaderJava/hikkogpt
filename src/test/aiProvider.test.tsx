import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_PROVIDERS,
  AI_PROVIDER_IDS,
  AI_PROVIDER_STORAGE_KEY,
  getStoredAiProvider,
  setStoredAiProvider,
  isAiProvider,
} from "@/types/ai-provider";
import { ProviderSelector } from "@/components/ProviderSelector";
import { SettingsPanel } from "@/components/SettingsPanel";

const root = process.cwd();
const readSource = (path: string) => readFileSync(resolve(root, path), "utf8");

beforeEach(() => {
  localStorage.clear();
});

describe("ai-provider: типы и localStorage", () => {
  it("по умолчанию выбран lovable", () => {
    expect(getStoredAiProvider()).toBe("lovable");
  });

  it("возвращает сохранённое значение", () => {
    setStoredAiProvider("gemini");
    expect(getStoredAiProvider()).toBe("gemini");
    expect(localStorage.getItem(AI_PROVIDER_STORAGE_KEY)).toBe("gemini");
  });

  it("битое значение в localStorage не ломает чтение", () => {
    localStorage.setItem(AI_PROVIDER_STORAGE_KEY, "openai");
    expect(getStoredAiProvider()).toBe("lovable");
  });

  it("isAiProvider принимает только поддерживаемые значения", () => {
    expect(isAiProvider("lovable")).toBe(true);
    expect(isAiProvider("gemini")).toBe(true);
    expect(isAiProvider("grok")).toBe(true);
    expect(isAiProvider("gpt")).toBe(false);
    expect(isAiProvider(null)).toBe(false);
    expect(isAiProvider(undefined)).toBe(false);
  });

  it("метаданные всех провайдеров заполнены", () => {
    expect(AI_PROVIDER_IDS).toEqual(["lovable", "gemini", "grok"]);
    for (const id of AI_PROVIDER_IDS) {
      const meta = AI_PROVIDERS[id];
      expect(meta.label).toBeTruthy();
      expect(meta.shortLabel).toBeTruthy();
      expect(meta.description).toBeTruthy();
    }
  });
});

describe("ProviderSelector", () => {
  it("full: рендерит три кнопки и вызывает onChange для Grok", () => {
    const onChange = vi.fn();
    render(<ProviderSelector value="lovable" onChange={onChange} variant="full" />);

    const lovableBtn = screen.getByRole("radio", { name: /Lovable AI/i });
    const geminiBtn = screen.getByRole("radio", { name: /Gemini API/i });
    const grokBtn = screen.getByRole("radio", { name: /Grok API/i });
    expect(lovableBtn).toHaveAttribute("aria-checked", "true");
    expect(geminiBtn).toHaveAttribute("aria-checked", "false");
    expect(grokBtn).toHaveAttribute("aria-checked", "false");

    fireEvent.click(grokBtn);
    expect(onChange).toHaveBeenCalledWith("grok");
  });

  it("compact: рендерит сегмент-контрол с короткими подписями", () => {
    const onChange = vi.fn();
    render(<ProviderSelector value="gemini" onChange={onChange} variant="compact" />);

    expect(screen.getByRole("radiogroup", { name: "API-провайдер" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);

    fireEvent.click(radios[0]);
    expect(onChange).toHaveBeenCalledWith("lovable");
  });
});

describe("SettingsPanel: секция провайдера", () => {
  const baseProps = {
    open: true,
    onClose: () => {},
    isDark: true,
    onToggleTheme: () => {},
    ttsVoice: "Aoede",
    onVoiceChange: () => {},
    onSignOut: () => {},
  };

  it("показывает кнопки переключения, когда передан onProviderChange", () => {
    const onProviderChange = vi.fn();
    render(<SettingsPanel {...baseProps} aiProvider="lovable" onProviderChange={onProviderChange} />);

    expect(screen.getByText("API-провайдер для чата")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Gemini API/i }));
    expect(onProviderChange).toHaveBeenCalledWith("gemini");
    fireEvent.click(screen.getByRole("radio", { name: /Grok API/i }));
    expect(onProviderChange).toHaveBeenLastCalledWith("grok");
  });

  it("скрывает секцию без onProviderChange (обратная совместимость)", () => {
    render(<SettingsPanel {...baseProps} />);
    expect(screen.queryByText("API-провайдер для чата")).not.toBeInTheDocument();
  });
});

describe("провайдер: сквозная проводка", () => {
  it("useChat хранит провайдер и отправляет его в edge-функцию", () => {
    const hook = readSource("src/hooks/useChat.ts");
    expect(hook).toContain("aiProvider");
    expect(hook).toContain("setAiProvider");
    expect(hook).toContain("provider: aiProvider");
    // Информирует пользователя, если сработал запасной провайдер.
    expect(hook).toContain("x-ai-provider");
  });

  it("Index показывает переключатель в шапке и пробрасывает его в настройки", () => {
    const page = readSource("src/pages/Index.tsx");
    expect(page).toContain("ProviderSelector");
    expect(page).toContain("onProviderChange");
    expect(page).toContain("toggleProvider");
  });

  it("edge-функция chat маршрутизирует по полю provider", () => {
    const fn = readSource("supabase/functions/chat/index.ts");
    // Читает выбор клиента; Lovable остаётся дефолтом.
    expect(fn).toContain('provider === "grok" ? "grok" : provider === "gemini" ? "gemini" : "lovable"');
    // Прямой вызов Google с ротацией ключей и поддержкой картинок.
    expect(fn).toContain("callGeminiDirect");
    expect(fn).toContain("getGeminiKeys");
    expect(fn).toContain("inlineData");
    // Сообщает фронтенду фактический провайдер ответа.
    expect(fn).toContain('"x-ai-provider": "gemini"');
    expect(fn).toContain('"x-ai-provider": "lovable"');
    expect(fn).toContain('"x-ai-provider": "grok"');
    expect(fn).toContain("callXaiChat");
    expect(fn).toContain('Deno.env.get("XAI_API_KEY")');
    expect(fn).toContain('Deno.env.get("GROK_CHAT_MODEL")');
    expect(fn).toContain("Access-Control-Expose-Headers");
    // Запасные переходы в обе стороны.
    expect(fn).toContain("falling back to Lovable gateway");
    expect(fn).toContain("falling back to direct Gemini API");
    expect(fn).toContain("Grok API unavailable, falling back to Lovable gateway");
  });
});
