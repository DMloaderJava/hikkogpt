/**
 * Server-side xAI (Grok) Chat Completions adapter.
 *
 * Chat Completions is the OpenAI-compatible stateless endpoint. It is used here
 * to preserve HikkoGPT's existing choices[0].delta SSE contract. Never pass an
 * xAI key from the browser; the caller supplies only the Edge Function secret.
 */

export interface XaiChatMessage {
  role: string;
  content: unknown;
}

const XAI_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";
const REASONING_MODEL_PATTERN = /^grok-4\.(?:5|6|7)(?:$|[-.])/i;

export async function callXaiChat(
  apiKey: string | undefined,
  model: string,
  messages: XaiChatMessage[],
  thinking: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<Response | null> {
  const key = apiKey?.trim();
  const modelId = model.trim();
  if (!key || !modelId || messages.length === 0) return null;

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
  };

  // Current Grok reasoning models support these effort levels. `low` keeps the
  // default chat path faster; the UI's thinking toggle raises it to `high`.
  if (REASONING_MODEL_PATTERN.test(modelId)) {
    body.reasoning_effort = thinking ? "high" : "low";
  }

  try {
    const response = await fetchFn(XAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      // Do not log prompt content, response bodies, or credentials.
      console.warn(`Grok API request failed [${response.status}]`);
      return null;
    }

    return response;
  } catch {
    // Avoid logging exception details that may contain request metadata.
    console.warn("Grok API request failed (network error)");
    return null;
  }
}
