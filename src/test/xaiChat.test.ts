import { describe, expect, it, vi } from "vitest";
import { callXaiChat } from "../../supabase/functions/chat/xai";

function createFetch(status: number, body = "data: [DONE]\n\n") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe("xAI Grok chat adapter", () => {
  it("uses the official endpoint, server bearer key, OpenAI-style messages, and SSE", async () => {
    const { fetchFn, calls } = createFetch(200);
    const messages = [
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hi" },
    ];

    const response = await callXaiChat("secret-xai-key", "grok-4.7", messages, false, fetchFn);

    expect(response?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer secret-xai-key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      model: "grok-4.7",
      messages,
      stream: true,
      reasoning_effort: "low",
    });
    expect(await response!.text()).toContain("data: [DONE]");
  });

  it("uses high reasoning effort when the thinking toggle is enabled", async () => {
    const { fetchFn, calls } = createFetch(200);
    await callXaiChat("key", "grok-4.7", [{ role: "user", content: "Think" }], true, fetchFn);
    expect(JSON.parse(String(calls[0].init.body)).reasoning_effort).toBe("high");
  });

  it("does not send unsupported reasoning parameters to other model IDs", async () => {
    const { fetchFn, calls } = createFetch(200);
    await callXaiChat("key", "grok-3", [{ role: "user", content: "Hi" }], true, fetchFn);
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("reasoning_effort");
  });

  it("does not call xAI if the server secret is missing", async () => {
    const { fetchFn, calls } = createFetch(200);
    expect(await callXaiChat(undefined, "grok-4.7", [{ role: "user", content: "Hi" }], false, fetchFn)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null on upstream errors so the caller can use its configured fallback", async () => {
    const { fetchFn, calls } = createFetch(401, "unauthorized");
    expect(await callXaiChat("bad-key", "grok-4.7", [{ role: "user", content: "Hi" }], false, fetchFn)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null on network failure without leaking exception details", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("network failure"); }) as unknown as typeof fetch;
    expect(await callXaiChat("key", "grok-4.7", [{ role: "user", content: "Hi" }], false, fetchFn)).toBeNull();
  });
});
