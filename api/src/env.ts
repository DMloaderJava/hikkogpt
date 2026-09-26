/**
 * Загрузка переменных окружения без внешних зависимостей.
 *
 * `dotenv` в проекте не используется, поэтому читаем `.env` сами:
 * сначала корневой `.env` репозитория, затем `api/.env` (он имеет приоритет).
 * Значения, уже выставленные в реальном окружении, не перезаписываются.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Корень репозитория: api/src/env.ts -> ../../ */
export const repoRoot = path.resolve(here, "..", "..");

function parseEnvFile(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // `export FOO=bar` — тоже валидная строка .env
    out[key.replace(/^export\s+/, "")] = value;
  }
  return out;
}

let loaded = false;

/** Подмешивает `.env`-файлы в `process.env` (идемпотентно). */
export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;
  for (const file of [path.join(repoRoot, ".env"), path.join(repoRoot, "api", ".env")]) {
    const values = parseEnvFile(file);
    for (const [key, value] of Object.entries(values)) {
      const current = process.env[key];
      if (current === undefined || current === "") process.env[key] = value;
    }
  }
}

export function envString(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
