import { createServerFn } from "@tanstack/react-start";
import type { CardIdentity, CardSide } from "./types";

export type PaddleVlResult =
  | { ok: true; identity: Partial<CardIdentity>; raw: string; model: string }
  | { ok: false; error: string };

const PROMPT =
  "OCR this trading card. Return JSON only: {\"player\":string|null,\"year\":number|null,\"manufacturer\":string|null,\"set\":string|null,\"number\":string|null,\"parallel\":string|null,\"side\":\"front\"|\"back\"|\"unknown\",\"rawText\":string}. Read printed text only.";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JPEG_BASE64_LENGTH = 240_000;

function asSide(value: unknown): CardSide {
  return value === "front" || value === "back" ? value : "unknown";
}

function parseJson(text: string): Partial<CardIdentity> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { rawText: text };
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const str = (k: string) =>
      typeof raw[k] === "string" && raw[k].trim()
        ? String(raw[k]).trim()
        : null;
    const yearRaw = raw.year;
    let year: number | null = null;
    if (typeof yearRaw === "number" && yearRaw >= 1980 && yearRaw <= 2026) year = yearRaw;
    if (typeof yearRaw === "string") {
      const n = Number((yearRaw.match(/19[8-9]\d|20[0-2]\d/) ?? [])[0]);
      if (n >= 1980 && n <= 2026) year = n;
    }
    return {
      player: str("player"),
      year,
      manufacturer: str("manufacturer"),
      set: str("set"),
      number: str("number"),
      parallel: str("parallel"),
      side: asSide(raw.side),
      rawText: str("rawText") ?? text,
    };
  } catch {
    return { rawText: text };
  }
}

async function fetchJsonWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json()) as unknown;
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function providerError(error: unknown): PaddleVlResult {
  return {
    ok: false,
    error: error instanceof Error && error.name === "AbortError" ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE",
  };
}

async function callSpace(jpeg: string): Promise<PaddleVlResult | null> {
  const space = process.env.HF_SPACE_URL?.trim();
  if (!space) return null;
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const { response, body } = await fetchJsonWithTimeout(
      `${space.replace(/\/$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "paddleocr-vl",
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg}` } },
                { type: "text", text: PROMPT },
              ],
            },
          ],
          max_tokens: 512,
        }),
      },
    );
    if (!response.ok) return { ok: false, error: `MODEL_UNAVAILABLE ${response.status}` };
    const text = (body as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
    const identity = parseJson(text);
    if (!identity) return { ok: false, error: "PROCESSING_FAILED" };
    return { ok: true, identity, raw: text, model: "PaddleOCR-VL-space" };
  } catch (error) {
    return providerError(error);
  }
}

async function callHf(jpeg: string): Promise<PaddleVlResult> {
  const fromSpace = await callSpace(jpeg);
  if (fromSpace?.ok) return fromSpace;
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN;
  const url = "https://router.huggingface.co/hf-inference/models/PaddlePaddle/PaddleOCR-VL-1.6";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const { response, body } = await fetchJsonWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: { image: jpeg },
        parameters: { max_new_tokens: 256, prompt: PROMPT },
      }),
    });
    if (!response.ok) return fromSpace ?? { ok: false, error: `MODEL_UNAVAILABLE ${response.status}` };
    const text =
      typeof body === "string"
        ? body
        : Array.isArray(body)
          ? String((body[0] as { generated_text?: string })?.generated_text ?? JSON.stringify(body))
          : JSON.stringify(body);
    const identity = parseJson(text);
    if (!identity) return { ok: false, error: "PROCESSING_FAILED" };
    return { ok: true, identity, raw: text, model: "PaddleOCR-VL-1.6" };
  } catch (error) {
    return fromSpace ?? providerError(error);
  }
}

export const readPaddleVl = createServerFn({ method: "POST" })
  .validator((data: { jpeg: string }) => {
    if (!data || typeof data.jpeg !== "string" || data.jpeg.length < 32) throw new Error("Missing image");
    if (data.jpeg.length > MAX_JPEG_BASE64_LENGTH || !/^[A-Za-z0-9+/=]+$/.test(data.jpeg)) {
      throw new Error("Invalid image");
    }
    return data;
  })
  .handler(async ({ data }): Promise<PaddleVlResult> => {
    try {
      const { applySecrets } = await import("./connectors/secrets-io");
      await applySecrets();
      return await callHf(data.jpeg);
    } catch (error) {
      return providerError(error);
    }
  });
