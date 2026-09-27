/**
 * Транскрипт реплик страницы манги → формат, который понимает `dialog-tts`.
 *
 * Зачем это нужно. Edge-функция `dialog-tts` разбирает текст жёстким шаблоном
 * `^Speaker\s*(\d{1,2})\s*:\s*(.+)$` (см. supabase/functions/dialog-tts/index.ts).
 * Всё, что ему не соответствует, она отбрасывает, и если таких строк не осталось —
 * отвечает 400 «Не найдено реплик». Модель при анализе манги обычно выдаёт
 * «Speaker 1: …», но регулярно переходит на «Рассказчик: …», «Аки: …» или просто
 * «— Привет»; пользователь тоже правит текст руками. Без нормализации кнопка
 * «Озвучить кадр» в таких случаях падает с ошибкой сервера.
 *
 * Здесь текст приводится к строгому формату на клиенте, а заодно заранее
 * проверяются ограничения озвучки (максимум 8 голосов, максимум 40 реплик
 * для 3+ голосов), чтобы показать понятную причину до запроса.
 */

/** Те же голоса и лимиты, что и в `dialog-tts` / `DialogTtsModal`. */
export const TTS_VOICES = ["Charon", "Kore", "Puck", "Aoede", "Fenrir", "Leda", "Zephyr", "Orus"] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

export const MAX_TTS_SPEAKERS = 8;
/** Ограничение `dialog-tts` для склейки 3+ голосов построчно. */
export const MAX_TTS_LINES_MULTI_VOICE = 40;

/** Голос по умолчанию для персонажа N (тот же порядок, что в `dialog-tts`). */
export function defaultVoiceFor(speaker: number): TtsVoice {
  const index = (speaker - 1) % TTS_VOICES.length;
  return TTS_VOICES[index >= 0 ? index : 0];
}

export interface TranscriptLine {
  /** Номер персонажа 1..MAX_TTS_SPEAKERS. */
  speaker: number;
  text: string;
}

export interface TranscriptPlan {
  lines: TranscriptLine[];
  /** Уникальные номера персонажей по возрастанию. */
  speakers: number[];
  /** Имена из текста: номер персонажа → имя (для подписей в UI). */
  names: Record<number, string>;
  /** Готовый текст в формате `Speaker N: реплика` для отправки в `dialog-tts`. */
  text: string;
  /** Почему озвучить нельзя (пусто = можно). Первая строка показывается пользователю. */
  problems: string[];
}

/** «Speaker 3: …», «Спикер 2 — …», «Голос 1: …». */
const EXPLICIT_RE = /^\s*(?:speaker|спикер|голос)\s*(\d{1,2})\s*[:.\-–—)]\s*(.*)$/i;
/** «Рассказчик: …», «Аки: …», «Старый мастер：…». */
const NAMED_RE = /^\s*([^:：\n]{1,40})[:：]\s*(.*)$/;
/** Маркер реплики без автора: «— Привет», «• Привет», «* Привет». */
const BULLET_RE = /^\s*[-–—•*▪‣]\s*/;

const clampSpeaker = (n: number) => Math.min(MAX_TTS_SPEAKERS, Math.max(1, Math.round(n) || 1));

/**
 * Разбирает произвольный текст на реплики.
 *
 * Правила (предсказуемые, без угадывания):
 * - «Speaker N: …» — персонаж N;
 * - «Имя: …» — персонажу выдаётся первый свободный номер, один и тот же для всех
 *   реплик этого имени;
 * - строка без автора («— Привет», продолжение реплики) — остаётся за предыдущим
 *   персонажем, а в самом начале текста за персонажем 1.
 */
export function parseTranscriptLines(raw: string): {
  lines: TranscriptLine[];
  names: Record<number, string>;
  /** Сколько имён не хватило свободного номера — их голоса слились с чужими. */
  overflow: number;
} {
  const lines: TranscriptLine[] = [];
  const names: Record<number, string> = {};
  const byName = new Map<string, number>();
  /** Уже занятые номера — чтобы «Имя: …» не получил голос явного Speaker N. */
  const used = new Set<number>();
  let lastSpeaker = 1;
  let overflow = 0;

  const takeFreeNumber = () => {
    for (let n = 1; n <= MAX_TTS_SPEAKERS; n += 1) {
      if (!used.has(n)) return n;
    }
    return null;
  };

  for (const rawLine of (raw ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const explicit = line.match(EXPLICIT_RE);
    if (explicit) {
      const speaker = clampSpeaker(parseInt(explicit[1], 10));
      const text = explicit[2].trim();
      lastSpeaker = speaker;
      used.add(speaker);
      if (text) lines.push({ speaker, text });
      continue;
    }

    const named = line.match(NAMED_RE);
    // «Смотри https://example.com» — двоеточие принадлежит схеме URL, а не имени.
    const looksLikeUrl = named ? named[2].trimStart().startsWith("//") : false;
    if (named && !looksLikeUrl) {
      const name = named[1].trim();
      const text = named[2].trim();
      if (name && text) {
        const key = name.toLowerCase();
        let speaker = byName.get(key);
        if (!speaker) {
          // Свободных номеров нет: персонаж больше лимита озвучки. Голос
          // делим с последним, но сообщаем об этом через overflow.
          const free = takeFreeNumber();
          speaker = free ?? MAX_TTS_SPEAKERS;
          overflow += free ? 0 : 1;
          byName.set(key, speaker);
          used.add(speaker);
          if (free) names[speaker] = name;
        }
        lastSpeaker = speaker;
        lines.push({ speaker, text });
        continue;
      }
    }

    const text = line.replace(BULLET_RE, "").trim();
    if (text) lines.push({ speaker: lastSpeaker, text });
  }

  return { lines, names, overflow };
}

/**
 * Диалог в том виде, в котором его ждёт пользователь и `dialog-tts`:
 * только реплики, каждая с новой строки, между ними пустая строка.
 *
 *     Speaker 1: Ребята, начинаем?
 *
 *     Speaker 2: Я сказала тебе прекратить!
 */
export function formatTranscript(text: string): string {
  return (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Вырезает из ответа модели всё, что не является репликой.
 *
 * Промпт `manga-analyze` просит строго «Speaker 1: …», но модель периодически
 * добавляет описание сцены, «Рассказчик: …», подписи кадров или markdown.
 * Правила предсказуемые:
 * - есть явные «Speaker N: …» — оставляем только их (пронумерованные строки и
 *   продолжения без автора), прочий текст выбрасываем;
 * - явных номеров нет — оставляем реплики с именами и без автора, а номера им
 *   выдаст `planTranscript`.
 */
/**
 * Служебные подписи, которые модель добавляет вопреки промпту: «Описание: …»,
 * «Примечание: …», «[Кадр 1]», «(перевод)». Репликами они не являются.
 */
const SERVICE_LINE_RE =
  /^\s*(?:\[|\(|\*|#+|`|>|\d+[.)]\s)|^\s*(?:описание|описания|примечание|комментарий|заметка|перевод|подпись|заголовок|description|note|comment|caption|translation|scene)\s*[:.\-–—)]/i;

/**
 * Вырезает из ответа модели всё, что не является репликой.
 *
 * Промпт `manga-analyze` просит строго «Speaker 1: …», но модель периодически
 * добавляет описание сцены, «Рассказчик: …», подписи кадров или markdown.
 * Правила предсказуемые:
 * - есть явные «Speaker N: …» — оставляем только их и строки без автора
 *   (продолжения реплик); любой текст с именем/служебной подписью выбрасываем;
 * - явных номеров нет — оставляем реплики с именами и без автора, а номера им
 *   выдаст `planTranscript`.
 */
export function dialogueOnly(raw: string): string {
  const lines = (raw ?? "").split("\n");
  const explicit = lines.some((line) => EXPLICIT_RE.test(line));
  const named = lines.some((line) => {
    const match = line.trim().match(NAMED_RE);
    return !!match && !match[2].trimStart().startsWith("//");
  });

  const kept: string[] = [];
  let lastWasLine = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      lastWasLine = false;
      continue;
    }
    // Заборы кода, подписи вида «[Кадр 1]» и служебный текст модели.
    if (/^(```|#|\*\*|\{|\}|—\s*$)/.test(line) || SERVICE_LINE_RE.test(line)) {
      lastWasLine = false;
      continue;
    }

    const isExplicit = EXPLICIT_RE.test(line);
    const isNamed = (() => {
      const match = line.match(NAMED_RE);
      return !!match && !match[2].trimStart().startsWith("//");
    })();

    if (isExplicit || (!explicit && (isNamed || (!named && BULLET_RE.test(line))))) {
      kept.push(line);
      lastWasLine = true;
      continue;
    }

    // Строка без автора — продолжение предыдущей реплики.
    if (lastWasLine && kept.length && !isNamed) {
      kept[kept.length - 1] = `${kept[kept.length - 1]} ${line.replace(BULLET_RE, "").trim()}`.trim();
      continue;
    }
    lastWasLine = false;
  }

  return kept.join("\n");
}

/** Ответ модели → реплики в формате `dialog-tts` (пусто, если реплик не нашли). */
export function normalizeModelTranscript(raw: string): string {
  const dialogue = dialogueOnly(raw ?? "");
  return dialogue ? formatTranscript(dialogue) : "";
}

/** Приводит текст к формату `dialog-tts` и проверяет лимиты озвучки. */
export function planTranscript(raw: string): TranscriptPlan {
  const { lines, names, overflow } = parseTranscriptLines(raw);
  const speakers = [...new Set(lines.map((l) => l.speaker))].sort((a, b) => a - b);
  const text = lines.map((l) => `Speaker ${l.speaker}: ${l.text}`).join("\n");

  const problems: string[] = [];
  if (!lines.length) {
    problems.push("Нет реплик для озвучки. Формат: «Имя: реплика» по одной на строку.");
  }
  if (overflow > 0) {
    problems.push(
      `Персонажей ${speakers.length + overflow}, а озвучка поддерживает до ${MAX_TTS_SPEAKERS} голосов.`
    );
  }
  if (speakers.length >= 3 && lines.length > MAX_TTS_LINES_MULTI_VOICE) {
    problems.push(
      `Для ${speakers.length} голосов максимум ${MAX_TTS_LINES_MULTI_VOICE} реплик, сейчас ${lines.length}. Разбейте страницу на части.`
    );
  }

  return { lines, speakers, names, text, problems };
}
