/**
 * LLM transport.
 *
 * Two OpenAI-compatible providers are supported and both speak the same
 * `POST {base}/chat/completions`:
 *
 *   - Berget AI   (`https://api.berget.ai/v1`)     — key from `BERGET_API_KEY`.
 *   - Pollinations (`https://gen.pollinations.ai/v1`) — key from
 *     `POLLINATIONS_API_KEY` / `VITE_POLLINATIONS_API_KEY`.
 *
 * The active provider is whatever is configured, with `VITE_LLM_PROVIDER`
 * choosing between them when both are. Every provider exposes a *pool* of
 * cheap models so each AI agent can run on a different one.
 *
 * Everything degrades gracefully: no key, a network error, a timeout or
 * unparseable JSON all return `null` and the caller falls back to scripted
 * behaviour. The game must never stall waiting for a model.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LlmProvider = "berget" | "pollinations";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  provider: LlmProvider;
}

/** A configured provider plus the cheap models its agents may be assigned. */
export interface ProviderConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /**
   * Cheap models, in preference order. Every one of them may be cast as crew
   * *or* imposter: the engine draws the traitors at random from this pool at
   * the start of each shift, so the cast changes from match to match.
   */
  models: string[];
}

/**
 * Pollinations' unified gateway. It is OpenAI-compatible and its catalog is
 * enormous, so this pool is deliberately limited to cheap, fast official
 * models — the game fires up to 150 model calls per match, a frontier model
 * would burn a key's budget, and community models can disappear mid-match.
 *
 * All of them are Quest-Pollen eligible (Quest covers only the eligible
 * catalog, unlike paid Pollen which unlocks everything), and each has been
 * verified to answer on `POST /v1/chat/completions` with JSON mode.
 *
 * Roles are drawn from this pool at random every shift — any model can be the
 * traitor, and the same pair never opens two shifts in a row.
 */
export const POLLINATIONS_BASE_URL = "https://gen.pollinations.ai/v1";
export const POLLINATIONS_MODELS = [
  "openai/gpt-6-luna",
  "nvidia/nemotron-3.5-lightning",
  "minimax/minimax-m3",
  "deepseek/deepseek-v4.1-flash",
  "mistralai/mistral-large-3",
] as const;

/**
 * Readable labels for the pool models, so an agent introduces itself as
 * "Minimax M3" rather than the raw provider/model ID "minimax/minimax-m3".
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "openai/gpt-6-luna": "GPT-6 Luna",
  "minimax/minimax-m3": "Minimax M3",
  "deepseek/deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "mistralai/mistral-large-3": "Mistral Large 3",
  "nvidia/nemotron-3.5-lightning": "Nemotron 3.5 Lightning",
  "mistral-small": "Mistral Small",
};

const MODEL_ACRONYMS = new Set(["gpt", "ai", "llm", "api", "oss"]);

/** Title-case one dash-separated segment, keeping version tokens tidy. */
function titleCaseSegment(segment: string): string {
  if (!segment) return segment;
  if (MODEL_ACRONYMS.has(segment.toLowerCase())) return segment.toUpperCase();
  // "m3" -> "M3", "v4.1" -> "V4.1"
  const versioned = /^([a-z])(\d.*)$/.exec(segment);
  if (versioned) return `${versioned[1].toUpperCase()}${versioned[2]}`;
  return segment[0].toUpperCase() + segment.slice(1);
}

/**
 * Turn a provider model ID into a readable name: `minimax/minimax-m3` →
 * "Minimax M3", `deepseek/deepseek-v4.1-flash` → "DeepSeek V4.1 Flash".
 * Unknown IDs still prettify, so `VITE_POLLINATIONS_MODELS` overrides render
 * legibly instead of falling back to the raw ID.
 */
export function modelDisplayName(id: string): string {
  const known = MODEL_DISPLAY_NAMES[id];
  if (known) return known;

  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const knownBare = MODEL_DISPLAY_NAMES[bare];
  if (knownBare) return knownBare;

  const segments = bare.split("-").filter(Boolean);
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prev = parts[parts.length - 1];
    // "gpt" + "6" -> "GPT-6" (keep a version glued to an acronym stem).
    if (
      /^\d/.test(seg) &&
      prev &&
      MODEL_ACRONYMS.has(segments[i - 1].toLowerCase())
    ) {
      parts[parts.length - 1] = `${prev}-${seg}`;
      continue;
    }
    parts.push(titleCaseSegment(seg));
  }
  return parts.join(" ") || id;
}

export const BERGET_BASE_URL = "https://api.berget.ai/v1";
const BERGET_DEFAULT_MODEL = "mistral-small";

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

function timeoutFromEnv(): number {
  const timeoutMs = Number(readEnv("VITE_LLM_TIMEOUT_MS") ?? 15000);
  return Number.isFinite(timeoutMs) ? timeoutMs : 15000;
}

function modelList(value: string | undefined, fallback: readonly string[]): string[] {
  const custom = value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return custom && custom.length > 0 ? custom : [...fallback];
}

/**
 * Every provider that has a key, in the order the game should prefer them.
 *
 * `VITE_LLM_PROVIDER=berget|pollinations` pins one to the top; otherwise the
 * first configured provider (Pollinations, then Berget) wins. No providers
 * means no model calls and pure heuristic agents.
 */
export function readProviders(): ProviderConfig[] {
  const timeoutMs = timeoutFromEnv();
  const providers: ProviderConfig[] = [];

  const pollinationsKey =
    readEnv("VITE_POLLINATIONS_API_KEY") ?? readEnv("POLLINATIONS_API_KEY");
  if (pollinationsKey) {
    providers.push({
      provider: "pollinations",
      baseUrl: (
        readEnv("VITE_POLLINATIONS_BASE_URL") ?? POLLINATIONS_BASE_URL
      ).replace(/\/+$/, ""),
      apiKey: pollinationsKey,
      timeoutMs,
      models: modelList(readEnv("VITE_POLLINATIONS_MODELS"), POLLINATIONS_MODELS),
    });
  }

  const bergetKey = readEnv("VITE_LLM_API_KEY") ?? readEnv("BERGET_API_KEY");
  if (bergetKey) {
    const models = modelList(
      readEnv("VITE_LLM_MODEL") ?? readEnv("BERGET_MODEL"),
      [BERGET_DEFAULT_MODEL],
    );
    providers.push({
      provider: "berget",
      baseUrl: (
        readEnv("VITE_LLM_BASE_URL") ??
        readEnv("BERGET_BASE_URL") ??
        BERGET_BASE_URL
      ).replace(/\/+$/, ""),
      apiKey: bergetKey,
      timeoutMs,
      models,
    });
  }

  const preferred = readEnv("VITE_LLM_PROVIDER")?.trim().toLowerCase();
  if (preferred === "berget" || preferred === "pollinations") {
    providers.sort(
      (a, b) =>
        (a.provider === preferred ? -1 : 0) -
        (b.provider === preferred ? -1 : 0),
    );
  }

  return providers;
}

/** The provider the match will actually use, or null when none is configured. */
export function activeProvider(): ProviderConfig | null {
  return readProviders()[0] ?? null;
}

/** Bind one of a provider's models into a ready-to-send config. */
export function configFor(provider: ProviderConfig, model: string): LlmConfig {
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    timeoutMs: provider.timeoutMs,
    provider: provider.provider,
  };
}

/**
 * Primary config: the active provider with its preferred model. Kept for the
 * scripts and callers that only need a single endpoint to talk to.
 */
export function readLlmConfig(): LlmConfig | null {
  const provider = activeProvider();
  if (!provider) return null;
  return configFor(provider, provider.models[0]);
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
  /**
   * Override the reasoning effort. Defaults to "high" on every provider — the
   * agents should think as hard as the models allow. "none" omits the field
   * (also used by the retry path when a provider rejects it).
   */
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

export async function complete(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: CompleteOptions = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  // Reasoning effort is maxed for every provider: the agents should think as
  // hard as the model allows. Models without the field simply ignore it, and a
  // provider that rejects it is retried below without it.
  const requestedEffort = opts.reasoningEffort ?? "high";
  const effort = requestedEffort === "none" ? undefined : requestedEffort;

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 220,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (effort) body.reasoning_effort = effort;

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
      // Some providers reject `response_format` or `reasoning_effort`; retry
      // once without the optional fields and let `extractJson` scrape prose.
      if ((opts.json || effort) && (res.status === 400 || res.status === 422)) {
        return complete(cfg, messages, {
          ...opts,
          json: false,
          reasoningEffort: "none",
        });
      }
      return null;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim().length > 0) return content;

    // Some gateways accept `response_format` but then emit nothing. Retry once
    // in plain mode and let `extractJson` scrape the object out of the prose.
    if (opts.json) return complete(cfg, messages, { ...opts, json: false });
    return null;
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
