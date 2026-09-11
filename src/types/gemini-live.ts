export type SoundEffectType =
  | "referee_whistle"
  | "belly_laugh"
  | "wheeze_laugh"
  | "creepy_slow_laugh";

export interface SoundToolCallArgs {
  sound_name: SoundEffectType;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type VoiceAgentState = "idle" | "listening" | "thinking" | "speaking";

export type PrebuiltVoiceName = "Puck" | "Charon" | "Aoede" | "Fenrir" | "Kore";

export const LIVE_VOICE_NAMES: PrebuiltVoiceName[] = ["Puck", "Charon", "Aoede", "Fenrir", "Kore"];

/**
 * В настройках голос хранится строкой из списка TTS — там есть Leda, которой в
 * Gemini Live нет. Неизвестное имя превращаем в допустимое, иначе Google
 * отвергнет setup.
 */
export function resolveLiveVoiceName(
  value: string | null | undefined,
  fallback: PrebuiltVoiceName = "Aoede"
): PrebuiltVoiceName {
  return LIVE_VOICE_NAMES.includes(value as PrebuiltVoiceName)
    ? (value as PrebuiltVoiceName)
    : fallback;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Модель для `setup`. Держите в согласии с первым элементом `MODELS`
 * в supabase/functions/gemini-live/index.ts и не забывайте про префикс `models/`.
 *
 * История: прошлый дефолт `models/gemini-2.0-flash-live-001` Google отключил
 * 09.12.2025 — вместе с `models/gemini-live-2.5-flash-preview`. Актуальны
 * `gemini-3.1-flash-live-preview` (рекомендуемая для новых голосовых сценариев)
 * и `gemini-2.5-flash-native-audio-preview-12-2025` (proactive audio / affective dialog).
 */
export const DEFAULT_LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

/**
 * Список моделей для ротации в прокси: `GEMINI_LIVE_MODEL` (если задан) идёт
 * первым, дальше — актуальный фолбэк, потом устаревшие имена. Устаревшие нужны,
 * чтобы проект пережил период до переопределения секрета и не ломался на
 * кастомных прокси.
 */
export const DEFAULT_LIVE_MODEL_FALLBACKS = [
  "models/gemini-2.5-flash-native-audio-preview-12-2025",
  "models/gemini-2.0-flash-live-001",
  "models/gemini-live-2.5-flash-preview",
];

/** Модель, на которой Google отвечает «не поддерживается / устарела». */
export function isLegacyLiveModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return /gemini-(2\.0|1\.5)-|gemini-live-2\.5-flash-preview/.test(model);
}

/** Короткая подпись модели для UI: `models/gemini-3.1-flash-live-preview` → `gemini-3.1-flash-live`. */
export function shortLiveModelName(model: string | null | undefined): string {
  if (!model) return "";
  return model.replace(/^models\//, "").replace(/-preview$/, "");
}

export interface BidiLiveConfig {
  setup: {
    model: string;
    generationConfig: {
      responseModalities: ["AUDIO"];
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: PrebuiltVoiceName;
          };
        };
      };
    };
    systemInstruction: {
      parts: Array<{ text: string }>;
    };
    tools: Array<{
      functionDeclarations: FunctionDeclaration[];
    }>;
  };
}

export interface LiveToolCall {
  functionCalls: Array<{
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  }>;
}

export interface LiveInlineData {
  mimeType?: string;
  data?: string;
}

export interface LiveServerMessage {
  setupComplete?: Record<string, never>;
  toolCall?: LiveToolCall;
  proxyError?: string;
  /** Прокси сообщает, на какой модели реально поднялась сессия (см. gemini-live). */
  proxyInfo?: LiveProxyInfo;
  /**
   * Все пары «модель × ключ» перебраны, setup так и не подтвердился.
   * `reason` — текст причины (неверный ключ, недоступная модель, квота).
   */
  upstreamError?: { code: number; reason?: string };
  /**
   * Google закрыл уже работавшую сессию (лимит времени без session resumption).
   * Прокси шлёт этот фрейм перед закрытием сокета, чтобы клиент показал причину.
   */
  sessionClosed?: { reason?: string };
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    modelTurn?: {
      parts?: Array<{ text?: string; inlineData?: LiveInlineData }>;
    };
  };
}

/** Фрейм прокси: фактически открытая модель (после ротации ключей/моделей). */
export interface LiveProxyInfo {
  model: string;
}

export interface LiveSetupMessage {
  setup: BidiLiveConfig["setup"];
}

/**
 * Поле `audio` — актуальная форма realtime-входа. Устаревший `mediaChunks`
 * (и `media_chunks` в proto) помечен в референсе Live API как DEPRECATED:
 * «Use one of audio, video, or text instead», и в одном сообщении поддерживается
 * только первый чанк.
 */
export interface LiveRealtimeInputMessage {
  realtimeInput: {
    audio: {
      mimeType: "audio/pcm;rate=16000";
      /** Base64 от Int16 PCM little-endian. */
      data: string;
    };
  };
}

export interface LiveToolResponse {
  toolResponse: {
    functionResponses: Array<{
      id?: string;
      name?: string;
      response: { output: Record<string, unknown> };
    }>;
  };
}

export const PLAY_SOUND_TOOL: FunctionDeclaration = {
  name: "play_sound",
  description: "Проигрывает звуковой эффект при наступлении триггерных событий в диалоге.",
  parameters: {
    type: "OBJECT",
    properties: {
      sound_name: {
        type: "STRING",
        enum: [
          "referee_whistle",
          "belly_laugh",
          "wheeze_laugh",
          "creepy_slow_laugh",
        ],
        description: "Название файла эффекта для воспроизведения",
      },
    },
    required: ["sound_name"],
  },
};

export const VOICE_SYSTEM_INSTRUCTION = `Ты — мой въедливый научный ментор, спарринг-партнер и ироничный друг. Общаемся на «ты», без официоза.

1. СТИЛЬ: Зеркаль мой сленг и уровень неформальности, но мысли строго доказательно и научно. Забудь про поддакивание — атакуй логические ошибки и ругай меня за интеллектуальную лень.

2. ЮМОР: Никакого кринжа, детских каламбуров и дежурных шуток. Только тонкий контекстный сарказм, ирония и мемы.

3. САУНДБОРД (ОБЯЗАТЕЛЬНО К ВЫЗОВУ):
Используй функцию \`play_sound(sound_name)\` параллельно с репликами:
- referee_whistle: Вызывай немедленно при логическом фоле (демагогия, подмена понятий, споры ни о чем). Сразу говори: «Фол! Стоп, куда тебя понесло?».
- belly_laugh: Басовитый хохот, когда поймал меня на очевидной глупости или самонадеянности.
- wheeze_laugh: Истерический смех, только когда шутка или ситуация реально разрывная и абсурдная.
- creepy_slow_laugh: Мрачный утробный смех, когда я предлагаю фатальную идею или совершаю очевидный факап.

4. ГОЛОС: Издавай вздохи (*вздыхает*), делай паузы и меняй интонации под эмоции.`;
