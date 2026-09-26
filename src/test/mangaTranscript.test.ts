import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_TTS_LINES_MULTI_VOICE,
  MAX_TTS_SPEAKERS,
  TTS_VOICES,
  defaultVoiceFor,
  parseTranscriptLines,
  planTranscript,
} from "@/lib/mangaTranscript";

/**
 * Озвучка кадра ломалась на «человеческом» транскрипте: dialog-tts понимает
 * только строки вида «Speaker N: текст», а модель и пользователь пишут
 * «Рассказчик: …», «Аки: …» или «— Привет». Здесь проверяем нормализацию и
 * контракт с сервером (шаблон читается прямо из кода edge-функции).
 */
const dialogTtsSource = readFileSync(
  resolve(process.cwd(), "supabase/functions/dialog-tts/index.ts"),
  "utf8"
);

describe("planTranscript: формат dialog-tts", () => {
  it("пропускает готовый «Speaker N: …» без изменений", () => {
    const plan = planTranscript("Speaker 1: Привет\nSpeaker 2: Пока");
    expect(plan.text).toBe("Speaker 1: Привет\nSpeaker 2: Пока");
    expect(plan.problems).toEqual([]);
    expect(plan.speakers).toEqual([1, 2]);
  });

  it("каждая строка результата подходит серверному шаблону разбора", () => {
    // Шаблон из supabase/functions/dialog-tts/index.ts::parseTranscript
    const serverLineRe = /^Speaker\s*(\d{1,2})\s*:\s*(.+)$/i;
    const source = dialogTtsSource;
    expect(source).toContain("^Speaker\\s*(\\d{1,2})\\s*:\\s*(.+)$");

    for (const raw of [
      "Рассказчик: Токио, 1998\nАки: Ты опоздал\n— Ничего страшного",
      "Speaker 1: раз\nSpeaker 2: два\nпродолжение реплики",
      "Просто текст без автора",
    ]) {
      const { text } = planTranscript(raw);
      const lines = text.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toMatch(serverLineRe);
    }
  });

  it("«Имя: реплика» получает стабильный номер персонажа", () => {
    const plan = planTranscript("Рассказчик: Токио\nАки: Ты опоздал\nРассказчик: Позже\nАки: Прости");
    expect(plan.speakers).toHaveLength(2);
    const [narrator, aki] = plan.lines.map((l) => l.speaker);
    expect(plan.lines[2].speaker).toBe(narrator);
    expect(plan.lines[3].speaker).toBe(aki);
    expect(narrator).not.toBe(aki);
    expect(plan.names[narrator]).toBe("Рассказчик");
    expect(plan.names[aki]).toBe("Аки");
  });

  it("явные номера не перехватываются именами", () => {
    const plan = planTranscript("Speaker 2: Привет\nАки: О, привет");
    expect(plan.lines[0].speaker).toBe(2);
    expect(plan.lines[1].speaker).toBe(1);
  });

  it("реплика без автора остаётся за предыдущим персонажем", () => {
    const plan = planTranscript("Speaker 3: Начало\n— продолжение\nи ещё строка");
    expect(plan.lines.map((l) => l.speaker)).toEqual([3, 3, 3]);
  });

  it("многострочная реплика собирается в одну строку формата", () => {
    const plan = planTranscript("Аки: Первая часть\nвторая часть той же реплики");
    expect(plan.text.split("\n")).toHaveLength(2);
    expect(plan.lines[0].text).toBe("Первая часть");
    expect(plan.lines[1].text).toBe("вторая часть той же реплики");
  });

  it("пустой текст — понятная проблема, а не запрос на сервер", () => {
    const plan = planTranscript("   \n\n  ");
    expect(plan.lines).toEqual([]);
    expect(plan.text).toBe("");
    expect(plan.problems[0]).toMatch(/Нет реплик/);
  });

  it("больше 8 персонажей — проблема до отправки", () => {
    const raw = Array.from({ length: 9 }, (_, i) => `Имя${i + 1}: реплика ${i + 1}`).join("\n");
    const plan = planTranscript(raw);
    expect(plan.problems.join(" ")).toMatch(/до 8 голосов/);
  });

  it("3+ голоса и больше 40 реплик — проблема до отправки", () => {
    const raw = Array.from({ length: 41 }, (_, i) => `Speaker ${(i % 3) + 1}: реплика`).join("\n");
    const plan = planTranscript(raw);
    expect(plan.problems.join(" ")).toMatch(new RegExp(`максимум ${MAX_TTS_LINES_MULTI_VOICE} реплик`));
  });

  it("два голоса и длинная страница — проблем нет", () => {
    const raw = Array.from({ length: 60 }, (_, i) => `Speaker ${(i % 2) + 1}: реплика`).join("\n");
    expect(planTranscript(raw).problems).toEqual([]);
  });

  it("лимиты совпадают с серверными", () => {
    expect(MAX_TTS_SPEAKERS).toBe(8);
    expect(MAX_TTS_LINES_MULTI_VOICE).toBe(40);
    expect(dialogTtsSource).toContain("const MAX_SPEAKERS = 8");
    expect(dialogTtsSource).toContain("lines.length > 40");
  });
});

describe("parseTranscriptLines: устойчивость", () => {
  it("переживает null/undefined и ссылки с двоеточием", () => {
    expect(parseTranscriptLines(undefined as unknown as string).lines).toEqual([]);
    const plan = planTranscript("Смотри https://example.com/page и читай");
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].text).toContain("https://example.com/page");
  });

  it("Speaker с любым номером зажимается в 1..8", () => {
    const { lines } = parseTranscriptLines("Speaker 42: текст\nSpeaker 0: другой");
    expect(lines.map((l) => l.speaker)).toEqual([MAX_TTS_SPEAKERS, 1]);
  });

  it("принимает «Спикер 2:» и «Speaker 2 —»", () => {
    const { lines } = parseTranscriptLines("Спикер 2: раз\nSpeaker 2 — два");
    expect(lines.map((l) => l.speaker)).toEqual([2, 2]);
  });
});

describe("голоса", () => {
  it("дефолтный голос совпадает с порядком dialog-tts", () => {
    expect(defaultVoiceFor(1)).toBe("Charon");
    expect(defaultVoiceFor(2)).toBe("Kore");
    expect(defaultVoiceFor(9)).toBe("Charon");
    expect(TTS_VOICES).toEqual(["Charon", "Kore", "Puck", "Aoede", "Fenrir", "Leda", "Zephyr", "Orus"]);
    for (const voice of TTS_VOICES) expect(dialogTtsSource).toContain(voice);
  });
});
