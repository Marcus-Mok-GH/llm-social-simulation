/**
 * LLM transport.
 *
 * Berget AI exposes an OpenAI-compatible `POST /v1/chat/completions`, so the
 * whole game only needs this one file to speak to any provider. Everything
 * degrades gracefully: no key, a network error, a timeout or unparseable JSON
 * all return `null` and the caller falls back to scripted behaviour. The game
 * must never stall waiting for a model.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

function readEnv(name: string): string | undefined {
  // Vite inlines `import.meta.env`; bun/node scripts read `process.env`.
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromMeta = meta?.[name];
  if (fromMeta) return fromMeta;
  if (typeof process !== "undefined") {
    const value = process.env?.[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * The API key is exposed to the browser on purpose: this is a client-only game
 * that talks to the model directly (CORS is enabled by the provider). It is
 * read from `BERGET_API_KEY` in the deployment environment, or from an
 * explicit `VITE_LLM_API_KEY` override.
 */
export function readLlmConfig(): LlmConfig | null {
  const apiKey = readEnv("VITE_LLM_API_KEY") ?? readEnv("BERGET_API_KEY");
  if (!apiKey) return null;

  const baseUrl = (
    readEnv("VITE_LLM_BASE_URL") ??
    readEnv("BERGET_BASE_URL") ??
    "https://api.berget.ai/v1"
  ).replace(/\/+$/, "");

  const model = readEnv("VITE_LLM_MODEL") ?? readEnv("BERGET_MODEL") ?? "mistral-small";
  const timeoutMs = Number(readEnv("VITE_LLM_TIMEOUT_MS") ?? 15000);

  return { baseUrl, apiKey, model, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15000 };
}

/** Serialises requests so a burst of agent ticks cannot flood the endpoint. */
export class RequestGate {
  private nextSlot = 0;
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(
    private readonly minIntervalMs = 250,
    private readonly maxConcurrent = 3,
  ) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minIntervalMs;
    if (start > now) await sleep(start - now);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for strict JSON mode before falling back to plain text. */
  json?: boolean;
}

export async function complete(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: CompleteOptions = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 220,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Some providers reject `response_format`; retry once without it.
      if (opts.json && (res.status === 400 || res.status === 422)) {
        return complete(cfg, messages, { ...opts, json: false });
      }
      return null;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim().length > 0 ? content : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the first JSON object out of a model reply. Models wrap output in
 * prose or fences more often than they obey instructions, so be permissive.
 */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];

  for (const raw of candidates) {
    if (!raw) continue;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
