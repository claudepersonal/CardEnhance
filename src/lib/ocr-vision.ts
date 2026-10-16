import { createServerFn } from "@tanstack/react-start";
import type { CardIdentity, CardSide } from "./types";

export type VisionOcrResult =
  | { ok: true; identity: Partial<CardIdentity> }
  | { ok: false; error: string };

const PROMPT = `You are reading a photograph of a trading card (sports, wrestling, TCG).
Read ONLY printed or foil lettering. Never identify a person by face.
If a name is not clearly printed, player must be null.
Return ONLY JSON:
{"player":string|null,"year":number|null,"manufacturer":string|null,"set":string|null,"number":string|null,"parallel":string|null,"side":"front"|"back"|"unknown","rawText":string}
Rules:
- player: Title Case printed subject (person, Pokemon, character). Not the league.
- year: integer copyright/set year if printed, else null. Use a number not a string.
- manufacturer: Topps, Panini, Upper Deck, Bowman, Pokemon, Konami, Wizards of the Coast, Donruss, Fleer.
- set: product line (Chrome, Prizm, Dazzlers, Base Set). NEVER the league (not AEW, WWE, NFL, NBA, MLB, NHL).
- number: printed card number such as DZ-2 or 12.
- parallel: Gold, Refractor, Holo, or a fraction like 15/50.
- side: front if art dominates, back if bio/legal text.
- rawText: all letters you can actually read.
Null if not printed. Do not invent.`;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JPEG_BASE64_LENGTH = 240_000;

function asSide(value: unknown): CardSide {
  return value === "front" || value === "back" ? value : "unknown";
}

function coerceYear(value: unknown, rawText: string): number | null {
  const from = (v: unknown) => {
    if (typeof v === "number" && v >= 1980 && v <= 2026) return v;
    if (typeof v === "string") {
      const n = Number((v.match(/19[8-9]\d|20[0-2]\d/) ?? [])[0]);
      if (n >= 1980 && n <= 2026) return n;
    }
    return null;
  };
  return from(value) ?? from((rawText.match(/©\s*(19[8-9]\d|20[0-2]\d)/i) ?? [])[1]);
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Ud|Aew|Wwe|Nfl|Nba|Mlb|Nhl|Tcg|Mtg)\b/g, (m) => m.toUpperCase());
}

function parseVisionJson(text: string): Partial<CardIdentity> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const str = (key: string) => (typeof raw[key] === "string" && raw[key].trim() ? String(raw[key]).trim() : null);
    const rawText = str("rawText") ?? text;
    let set = str("set");
    if (set && /^(aew|wwe|nfl|nba|mlb|nhl|ufc|mls|ncaa)$/i.test(set)) set = null;
    let manufacturer = str("manufacturer");
    if (manufacturer) {
      if (/upper\s*deck/i.test(manufacturer)) manufacturer = "Upper Deck";
      else if (/topps/i.test(manufacturer)) manufacturer = "Topps";
      else if (/panini/i.test(manufacturer)) manufacturer = "Panini";
      else if (/bowman/i.test(manufacturer)) manufacturer = "Bowman";
      else if (/pok/i.test(manufacturer)) manufacturer = "Pokemon";
      else manufacturer = titleCase(manufacturer);
    }
    let player = str("player");
    if (player) player = titleCase(player);
    return {
      player,
      year: coerceYear(raw.year, rawText),
      manufacturer,
      set: set ? titleCase(set) : null,
      number: str("number"),
      parallel: str("parallel"),
      side: asSide(raw.side),
      rawText,
    };
  } catch {
    return null;
  }
}

async function fetchVisionJson(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

export const readTradingCard = createServerFn({ method: "POST" })
  .validator((data: { jpeg: string }) => {
    if (!data || typeof data.jpeg !== "string" || data.jpeg.length < 32) {
      throw new Error("Missing image");
    }
    if (data.jpeg.length > MAX_JPEG_BASE64_LENGTH || !/^[A-Za-z0-9+/=]+$/.test(data.jpeg)) {
      throw new Error("Invalid image");
    }
    return data;
  })
  .handler(async ({ data }): Promise<VisionOcrResult> => {
    try {
      const { applySecrets } = await import("./connectors/secrets-io");
      await applySecrets();
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) return { ok: false, error: "unavailable" };

      const { response, body } = await fetchVisionJson("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-4.5",
          max_tokens: 420,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${data.jpeg}`, detail: "high" },
                },
                { type: "text", text: PROMPT },
              ],
            },
          ],
        }),
      });

      if (!response.ok) return { ok: false, error: `vision ${response.status}` };
      const text = body.choices?.[0]?.message?.content ?? "";
      const identity = parseVisionJson(text);
      if (!identity || (!identity.player && !identity.manufacturer && !identity.year)) {
        return { ok: false, error: "empty" };
      }
      return { ok: true, identity };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error && error.name === "AbortError" ? "timeout" : "unavailable",
      };
    }
  });
