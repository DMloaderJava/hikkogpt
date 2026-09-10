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

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    modelTurn?: {
      parts?: Array<{ text?: string; inlineData?: LiveInlineData }>;
    };
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
