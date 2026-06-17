import type { AppEnv } from "./types";

// Google Gemini REST client for the Workers runtime — plain fetch(), no SDK.
// Verified shape: POST .../v1beta/models/<id>:generateContent with the API key
// in the x-goog-api-key header (Google's recommended form).

const DEFAULT_MODEL = "gemini-3.5-flash";
const FALLBACK_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function baseUrl(env: AppEnv): string {
  return (env.GEMINI_BASE_URL && env.GEMINI_BASE_URL.trim().replace(/\/$/, "")) || DEFAULT_BASE;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code: number; message: string; status: string };
}

export interface GeminiResult {
  ok: boolean;
  text: string;
  model?: string;
  error?: string;
  status?: string;
}

export interface GenerateOptions {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  json?: boolean;
  // Gemini 2.5+/3.x "flash" models spend output tokens on internal "thinking"
  // before any visible text. Left unchecked this silently eats maxOutputTokens
  // (→ finishReason MAX_TOKENS with empty text) and truncates JSON. Default 0
  // disables thinking so the whole budget goes to the answer.
  thinkingBudget?: number;
}

export function geminiConfigured(env: AppEnv): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

function preferredModel(env: AppEnv): string {
  return (env.GEMINI_MODEL && env.GEMINI_MODEL.trim()) || DEFAULT_MODEL;
}

type CallOutcome = { result: GeminiResult; notFound: boolean; retriable: boolean };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOnce(env: AppEnv, model: string, options: GenerateOptions): Promise<CallOutcome> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.4,
      maxOutputTokens: options.maxOutputTokens ?? 1536,
      responseMimeType: options.json ? "application/json" : "text/plain",
      thinkingConfig: { thinkingBudget: options.thinkingBudget ?? 0 },
    },
  };
  if (options.system) {
    body.systemInstruction = { parts: [{ text: options.system }] };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-goog-api-key": env.GEMINI_API_KEY as string,
  };
  // Authenticated Cloudflare AI Gateway (proxies Gemini from a supported region).
  if (env.AI_GATEWAY_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}/${model}:generateContent`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return { result: { ok: false, text: "", model, error: `network: ${String(err)}` }, notFound: false, retriable: true };
  }

  let data: GeminiResponse;
  try {
    data = (await res.json()) as GeminiResponse;
  } catch {
    return {
      result: { ok: false, text: "", model, error: `bad_json HTTP ${res.status}` },
      notFound: res.status === 404,
      retriable: res.status >= 500,
    };
  }

  if (!res.ok || data.error) {
    const status = data.error?.status ?? `HTTP_${res.status}`;
    const notFound = res.status === 404 || status === "NOT_FOUND";
    const retriable = res.status >= 500 || status === "UNAVAILABLE" || status === "INTERNAL";
    return {
      result: {
        ok: false,
        text: "",
        model,
        status,
        error: data.error?.message ?? `Gemini request failed (HTTP ${res.status})`,
      },
      notFound,
      retriable,
    };
  }

  if (data.promptFeedback?.blockReason) {
    return {
      result: { ok: false, text: "", model, error: `prompt_blocked: ${data.promptFeedback.blockReason}` },
      notFound: false,
      retriable: false,
    };
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) {
    return {
      result: { ok: false, text: "", model, error: `no_text: ${candidate?.finishReason ?? "UNKNOWN"}` },
      notFound: false,
      retriable: false,
    };
  }

  return { result: { ok: true, text, model }, notFound: false, retriable: false };
}

// Retry transient 5xx / UNAVAILABLE (model overload) a couple times with backoff.
async function callWithRetry(env: AppEnv, model: string, options: GenerateOptions): Promise<CallOutcome> {
  let outcome = await callOnce(env, model, options);
  let attempt = 1;
  while (!outcome.result.ok && outcome.retriable && attempt < 3) {
    await sleep(700 * attempt);
    outcome = await callOnce(env, model, options);
    attempt += 1;
  }
  return outcome;
}

// Generate text. Transient overloads are retried; a 404 (bad/unavailable model id)
// falls back to the well-proven model so a wrong GEMINI_MODEL never hard-fails.
export async function generate(env: AppEnv, options: GenerateOptions): Promise<GeminiResult> {
  if (!geminiConfigured(env)) {
    return { ok: false, text: "", error: "missing_gemini_api_key" };
  }

  const primary = preferredModel(env);
  const first = await callWithRetry(env, primary, options);
  if (first.result.ok) return first.result;

  // Fall back to the proven model on a bad model id (404) OR persistent overload
  // (5xx/UNAVAILABLE) — a different model is often less loaded.
  if ((first.notFound || first.retriable) && primary !== FALLBACK_MODEL) {
    const second = await callWithRetry(env, FALLBACK_MODEL, options);
    if (second.result.ok) {
      const reason = first.notFound ? `primary_model_not_found:${primary}` : `primary_overloaded:${primary}`;
      return { ...second.result, error: reason };
    }
    return second.result;
  }
  return first.result;
}

// Parse a JSON object out of a model response, tolerating code fences or
// surrounding prose.
export function extractJson<T>(text: string): T | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export { DEFAULT_MODEL, FALLBACK_MODEL };
