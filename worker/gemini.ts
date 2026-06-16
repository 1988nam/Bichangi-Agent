import type { AppEnv } from "./types";

// Google Gemini REST client for the Workers runtime — plain fetch(), no SDK.
// Verified shape: POST .../v1beta/models/<id>:generateContent with the API key
// in the x-goog-api-key header (Google's recommended form).

const DEFAULT_MODEL = "gemini-3.5-flash";
const FALLBACK_MODEL = "gemini-2.5-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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

async function callOnce(
  env: AppEnv,
  model: string,
  options: GenerateOptions,
): Promise<{ result: GeminiResult; notFound: boolean }> {
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

  let res: Response;
  try {
    res = await fetch(`${BASE}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY as string,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return {
      result: { ok: false, text: "", model, error: `network: ${String(err)}` },
      notFound: false,
    };
  }

  let data: GeminiResponse;
  try {
    data = (await res.json()) as GeminiResponse;
  } catch {
    return {
      result: { ok: false, text: "", model, error: `bad_json HTTP ${res.status}` },
      notFound: res.status === 404,
    };
  }

  if (!res.ok || data.error) {
    const status = data.error?.status ?? `HTTP_${res.status}`;
    const notFound = res.status === 404 || status === "NOT_FOUND";
    return {
      result: {
        ok: false,
        text: "",
        model,
        status,
        error: data.error?.message ?? `Gemini request failed (HTTP ${res.status})`,
      },
      notFound,
    };
  }

  if (data.promptFeedback?.blockReason) {
    return {
      result: { ok: false, text: "", model, error: `prompt_blocked: ${data.promptFeedback.blockReason}` },
      notFound: false,
    };
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) {
    return {
      result: { ok: false, text: "", model, error: `no_text: ${candidate?.finishReason ?? "UNKNOWN"}` },
      notFound: false,
    };
  }

  return { result: { ok: true, text, model }, notFound: false };
}

// Generate text. On a 404 (bad/unavailable model id) automatically retries once
// with the well-proven fallback model so a wrong GEMINI_MODEL never hard-fails.
export async function generate(env: AppEnv, options: GenerateOptions): Promise<GeminiResult> {
  if (!geminiConfigured(env)) {
    return { ok: false, text: "", error: "missing_gemini_api_key" };
  }

  const primary = preferredModel(env);
  const first = await callOnce(env, primary, options);
  if (first.result.ok || !first.notFound) return first.result;

  if (primary !== FALLBACK_MODEL) {
    const second = await callOnce(env, FALLBACK_MODEL, options);
    if (second.result.ok) {
      return { ...second.result, error: `primary_model_not_found:${primary}` };
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
