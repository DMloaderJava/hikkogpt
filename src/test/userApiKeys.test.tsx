import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_USER_GEMINI_KEYS,
  getStoredUserKeyIndex,
  getStoredUserKeys,
  looksLikeGoogleKey,
  maskApiKey,
  mergeUserKeys,
  parsePastedKeys,
  setStoredUserKeyIndex,
  setStoredUserKeys,
} from "@/lib/userApiKeys";
import { UserApiKeysEditor } from "@/components/UserApiKeysEditor";
import { SettingsPanel } from "@/components/SettingsPanel";

const root = process.cwd();
const readSource = (path: string) => readFileSync(resolve(root, path), "utf8");

beforeEach(() => {
  localStorage.clear();
});

describe("userApiKeys: парсинг и слияние", () => {
  it("лимит — 15 ключей", () => {
    expect(MAX_USER_GEMINI_KEYS).toBe(15);
  });

  it("parsePastedKeys режет по пробелам, запятым и переносам строк", () => {
    expect(parsePastedKeys("key11111 key22222\nkey33333,key44444;key55555")).toEqual([
      "key11111",
      "key22222",
      "key33333",
      "key44444",
      "key55555",
    ]);
  });

  it("parsePastedKeys отбрасывает мусор короче 8 символов", () => {
    expect(parsePastedKeys("abc key11111  , ")).toEqual(["key11111"]);
    expect(parsePastedKeys("   ")).toEqual([]);
  });

  it("mergeUserKeys добавляет новые и считает дубликаты", () => {
    const res = mergeUserKeys(["a1111111"], ["b2222222", "a1111111", "c3333333"], 10);
    expect(res.merged).toEqual(["a1111111", "b2222222", "c3333333"]);
    expect(res.added).toBe(2);
    expect(res.duplicates).toBe(1);
    expect(res.overflow).toBe(0);
  });

  it("mergeUserKeys не превышает лимит", () => {
    const res = mergeUserKeys(["a1111111", "b2222222"], ["c3333333", "d4444444"], 3);
    expect(res.merged).toHaveLength(3);
    expect(res.added).toBe(1);
    expect(res.overflow).toBe(1);
  });

  it("maskApiKey показывает только начало и конец", () => {
    expect(maskApiKey("AIzaSyD1234567890abcdefABCDEF1234567890")).toBe("AIza••••••••7890");
    expect(maskApiKey("short")).toBe("••••••••");
  });

  it("looksLikeGoogleKey отличает формат AIza...", () => {
    expect(looksLikeGoogleKey("AIzaSyD1234567890abcdefABCDEF1234567890")).toBe(true);
    expect(looksLikeGoogleKey("sk-1234567890abcdef")).toBe(false);
    expect(looksLikeGoogleKey("AIza-short")).toBe(false);
  });
});

describe("userApiKeys: localStorage", () => {
  it("ключи переживают перезагрузку, мусор отфильтровывается", () => {
    setStoredUserKeys(["k11111111", "k22222222"]);
    expect(getStoredUserKeys()).toEqual(["k11111111", "k22222222"]);
    localStorage.setItem("hikko-gemini-user-keys", "not-json");
    expect(getStoredUserKeys()).toEqual([]);
  });

  it("индекс активного ключа хранится отдельно", () => {
    expect(getStoredUserKeyIndex()).toBe(0);
    setStoredUserKeyIndex(4);
    expect(getStoredUserKeyIndex()).toBe(4);
    localStorage.setItem("hikko-gemini-user-key-index", "oops");
    expect(getStoredUserKeyIndex()).toBe(0);
  });
});

describe("UserApiKeysEditor", () => {
  const handlers = () => ({ onAdd: vi.fn(), onRemove: vi.fn(), onClear: vi.fn() });

  it("пустой список свёрнут, счётчик 0/15", () => {
    render(<UserApiKeysEditor keys={[]} activeIndex={0} {...handlers()} />);
    expect(screen.getByText("Мои Gemini ключи")).toBeInTheDocument();
    expect(screen.getByText("0/15")).toBeInTheDocument();
    expect(screen.queryByLabelText("Новые Gemini API ключи")).not.toBeInTheDocument();
    // Раскрывается по клику.
    fireEvent.click(screen.getByText("Мои Gemini ключи"));
    expect(screen.getByLabelText("Новые Gemini API ключи")).toBeInTheDocument();
  });

  it("показывает замаскированные ключи и активный помечает", () => {
    const h = handlers();
    render(
      <UserApiKeysEditor
        keys={["AIzaSyD1234567890abcdefABCDEF1234567890", "AIzaSyD0987654321fedcbaFEDCBA0987654321"]}
        activeIndex={1}
        {...h}
      />
    );
    expect(screen.getByText("2/15")).toBeInTheDocument();
    expect(screen.getByText("AIza••••••••7890")).toBeInTheDocument();
    expect(screen.getByText("AIza••••••••4321")).toBeInTheDocument();
    // Подсказка про хранение и ротацию.
    expect(screen.getByText(/только на этом устройстве/)).toBeInTheDocument();
  });

  it("кнопка Показать раскрывает ключи целиком", () => {
    render(<UserApiKeysEditor keys={["AIzaSyD1234567890abcdefABCDEF1234567890"]} activeIndex={0} {...handlers()} />);
    fireEvent.click(screen.getByText("Показать"));
    expect(screen.getByText("AIzaSyD1234567890abcdefABCDEF1234567890")).toBeInTheDocument();
  });

  it("добавление вызывает onAdd и очищает поле", () => {
    const h = handlers();
    render(<UserApiKeysEditor keys={[]} activeIndex={0} {...h} />);
    fireEvent.click(screen.getByText("Мои Gemini ключи"));
    const input = screen.getByLabelText("Новые Gemini API ключи");
    fireEvent.change(input, { target: { value: "key11111 key22222" } });
    fireEvent.click(screen.getByLabelText("Добавить ключи"));
    expect(h.onAdd).toHaveBeenCalledWith("key11111 key22222");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("Enter тоже отправляет", () => {
    const h = handlers();
    render(<UserApiKeysEditor keys={[]} activeIndex={0} {...h} />);
    fireEvent.click(screen.getByText("Мои Gemini ключи"));
    const input = screen.getByLabelText("Новые Gemini API ключи");
    fireEvent.change(input, { target: { value: "key11111" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onAdd).toHaveBeenCalledWith("key11111");
  });

  it("удаление и очистка вызывают колбэки", () => {
    const h = handlers();
    render(<UserApiKeysEditor keys={["k11111111", "k22222222"]} activeIndex={0} {...h} />);
    fireEvent.click(screen.getByLabelText("Удалить ключ 1"));
    expect(h.onRemove).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByText("Очистить все"));
    expect(h.onClear).toHaveBeenCalled();
  });

  it("при 15 ключах поле вставки прячется", () => {
    const keys = Array.from({ length: 15 }, (_, i) => `key-${i}-111111`);
    render(<UserApiKeysEditor keys={keys} activeIndex={0} {...handlers()} />);
    expect(screen.getByText("15/15")).toBeInTheDocument();
    expect(screen.queryByLabelText("Новые Gemini API ключи")).not.toBeInTheDocument();
    expect(screen.getByText(/Достигнут лимит/)).toBeInTheDocument();
  });
});

describe("SettingsPanel: секция ключей", () => {
  const baseProps = {
    open: true,
    onClose: () => {},
    isDark: true,
    onToggleTheme: () => {},
    ttsVoice: "Aoede",
    onVoiceChange: () => {},
    onSignOut: () => {},
  };

  it("показывает редактор, когда переданы колбэки", () => {
    render(
      <SettingsPanel
        {...baseProps}
        userKeys={["k11111111"]}
        activeKeyIndex={0}
        onAddUserKeys={() => {}}
        onRemoveUserKey={() => {}}
        onClearUserKeys={() => {}}
      />
    );
    expect(screen.getByText("Мои Gemini ключи")).toBeInTheDocument();
  });

  it("скрывает секцию без колбэков (обратная совместимость)", () => {
    render(<SettingsPanel {...baseProps} />);
    expect(screen.queryByText("Мои Gemini ключи")).not.toBeInTheDocument();
  });
});

describe("ключи: сквозная проводка", () => {
  it("useChat отправляет ключи и запоминает сработавший", () => {
    const hook = readSource("src/hooks/useChat.ts");
    expect(hook).toContain("userKeys: userGeminiKeys");
    expect(hook).toContain("userKeyIndex: activeKeyIndex");
    expect(hook).toContain("x-ai-key-source");
    expect(hook).toContain("x-ai-key-index");
    expect(hook).toContain("setActiveKeyIndex");
  });

  it("Index пробрасывает ключи в настройки", () => {
    const page = readSource("src/pages/Index.tsx");
    expect(page).toContain("userGeminiKeys");
    expect(page).toContain("onAddUserKeys");
    expect(page).toContain("onRemoveUserKey");
    expect(page).toContain("onClearUserKeys");
  });

  it("edge-функция перебирает ключи пользователя по кругу", () => {
    const fn = readSource("supabase/functions/chat/index.ts");
    // Принимает ключи клиента (до 15) и стартовый индекс.
    expect(fn).toContain("clientKeys");
    expect(fn).toContain("startIndex % clientKeys.length");
    // Сначала пользовательские, затем серверные; сообщает, какой сработал.
    expect(fn).toContain('source: "user"');
    expect(fn).toContain('source: "server"');
    expect(fn).toContain('"x-ai-key-index"');
    expect(fn).toContain('"x-ai-key-source"');
    // Значения ключей в логи не попадают.
    expect(fn).not.toMatch(/console\.(log|warn|error)\([^)]*attempt\.key/);
    expect(fn).not.toMatch(/console\.(log|warn|error)\([^)]*clientKeys/);
  });
});
