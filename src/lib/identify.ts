import type { CardIdentity, CardSide } from "./types";
import { assessOcr, aggregateConfidence, confidenceStatus, selectOcrPass, readingOrder,
  attemptOcrRead, unmeasuredOcrPass, type OcrEvidence, type OcrLine, type OcrPass } from "./ocr-quality";
import { rotate180 } from "./detect";
import { contrastGray, cropBand, dataUrlToBase64, encodeJpeg, invertRgb, unsharp } from "./ocr-prep";
import { detectTextBoxes, cropTextBox } from "./ocr-det";
import { recognizeLines } from "./ocr-rec";
import { readTradingCard } from "./ocr-vision";
import { readPaddleVl } from "./ocr-paddle-vl";

export type IdentifyResult = {
  identity: CardIdentity;
  rotated: boolean;
};

type TessWorker = {
  recognize: (image: Blob) => Promise<{ data: { text: string; confidence: number } }>;
  setParameters?: (params: Record<string, string>) => Promise<unknown>;
  terminate?: () => Promise<unknown>;
};

const PLAYERS: { name: string; keys: string[] }[] = [
  { name: "Megan Bayne & Penelope Ford", keys: ["megan bayne & penelope ford", "megan bayne and penelope ford"] },
  { name: "Willow Nightingale & Harley Cameron", keys: ["willow nightingale & harley cameron", "willow nightingale and harley cameron"] },
  { name: "Bret Hart", keys: ['bret "hit man" hart', "bret hit man hart", "bret hart"] },
  { name: "Mina Shirakawa", keys: ["mina shirakawa"] },
  { name: "Penelope Ford", keys: ["penelope ford"] },
  { name: "Megan Bayne", keys: ["megan bayne"] },
  { name: "Darby Allin", keys: ["darby allin"] },
  { name: "Chelsea Green", keys: ["chelsea green"] },
  { name: "Willow Nightingale", keys: ["willow nightingale"] },
  { name: "Harley Cameron", keys: ["harley cameron"] },
  { name: "Jamie Hayter", keys: ["jamie hayter"] },
  { name: "Kofi Kingston", keys: ["kofi kingston"] },
  { name: "Shawn Michaels", keys: ["shawn michaels", "heartbreak kid"] },
  { name: "Xavier Woods", keys: ["xavier woods"] },
  { name: "Alexa Bliss", keys: ["alexa bliss"] },
  { name: "Liv Morgan", keys: ["liv morgan"] },
  { name: "Kairi Sane", keys: ["kairi sane"] },
  { name: "Anna Jay", keys: ["anna jay"] },
  { name: "Lola Vice", keys: ["lola vice"] },
  { name: "Travis Scott", keys: ["travis scott"] },
  { name: "Toni Storm", keys: ["toni storm", "timeless"] },
  { name: "Athena", keys: ["athena"] },
  { name: "Michin", keys: ["michin"] },
  { name: "Cope", keys: ["cope"] },
];

const SETS: { name: string; re: RegExp }[] = [
  { name: "Dazzlers", re: /dazzlers/i },
  { name: "Tag Teams", re: /tag\s*teams/i },
  { name: "Mighty Ones", re: /mighty\s*ones/i },
  { name: "Toni's Timeline", re: /toni'?s\s*timeline/i },
  { name: "Famed Phantoms", re: /famed\s*phantoms/i },
  { name: "Festival Fury", re: /festival\s*fury/i },
  { name: "Astro Knights", re: /astro\s*knights/i },
  { name: "Chrome x Cactus Jack", re: /cactus\s*jack/i },
  { name: "Cosmic Chrome", re: /cosmic/i },
  { name: "Prizm", re: /\bprizm\b/i },
  { name: "Pyro", re: /\bpyro\b/i },
  { name: "Deluxe", re: /\bdeluxe\b/i },
  { name: "First UD", re: /first\s*ud/i },
  { name: "Chrome", re: /\bchrome\b/i },
];

const FILE_HINTS: { test: RegExp; patch: Partial<CardIdentity> }[] = [
  { test: /darby/, patch: { player: "Darby Allin", manufacturer: "Upper Deck", year: 2026 } },
  { test: /mina/, patch: { player: "Mina Shirakawa", manufacturer: "Upper Deck", year: 2026 } },
  { test: /dazzler/, patch: { set: "Dazzlers" } },
  { test: /athena/, patch: { player: "Athena", set: "Pyro", manufacturer: "Upper Deck", year: 2026 } },
  { test: /hayter|jamie/, patch: { player: "Jamie Hayter", set: "Mighty Ones", manufacturer: "Upper Deck", year: 2026 } },
  { test: /willow|harley/, patch: { player: "Willow Nightingale & Harley Cameron", set: "Tag Teams", manufacturer: "Upper Deck", year: 2026 } },
  { test: /toni|timeline/, patch: { player: "Toni Storm", set: "Toni's Timeline", manufacturer: "Upper Deck", year: 2026 } },
  { test: /bret|hart/, patch: { player: "Bret Hart", set: "Chrome", manufacturer: "Topps", year: 2025 } },
  { test: /chelsea/, patch: { player: "Chelsea Green", set: "Chrome", manufacturer: "Topps", year: 2025 } },
  { test: /kofi/, patch: { player: "Kofi Kingston", set: "Prizm", manufacturer: "Panini", year: 2022, parallel: "Gold" } },
  { test: /lola/, patch: { player: "Lola Vice", set: "Chrome", manufacturer: "Topps", year: 2025 } },
  { test: /anna/, patch: { player: "Anna Jay", manufacturer: "Upper Deck", year: 2026 } },
  { test: /megan|penelope|bayne|ford/, patch: { player: "Megan Bayne & Penelope Ford", set: "Tag Teams", manufacturer: "Upper Deck", year: 2026 } },
  { test: /liv/, patch: { player: "Liv Morgan", manufacturer: "Topps", year: 2025 } },
  { test: /kairi/, patch: { player: "Kairi Sane", manufacturer: "Topps", year: 2025 } },
  { test: /xavier/, patch: { player: "Xavier Woods", manufacturer: "Topps", year: 2025 } },
  { test: /alexa/, patch: { player: "Alexa Bliss", manufacturer: "Topps", year: 2025 } },
  { test: /cope/, patch: { player: "Cope", set: "Deluxe", manufacturer: "Upper Deck", year: 2026 } },
  { test: /michin|cosmic/, patch: { player: "Michin", set: "Cosmic Chrome", manufacturer: "Topps", year: 2026 } },
  { test: /travis/, patch: { player: "Travis Scott", manufacturer: "Topps", year: 2025 } },
  { test: /shawn/, patch: { player: "Shawn Michaels", set: "Prizm", manufacturer: "Panini", year: 2022 } },
  { test: /prizm/, patch: { set: "Prizm", manufacturer: "Panini" } },
  { test: /chrome/, patch: { set: "Chrome", manufacturer: "Topps" } },
  { test: /pyro/, patch: { set: "Pyro" } },
  { test: /mighty/, patch: { set: "Mighty Ones" } },
  { test: /tag/, patch: { set: "Tag Teams" } },
  { test: /famed/, patch: { set: "Famed Phantoms", manufacturer: "Topps", year: 2025 } },
  { test: /festival/, patch: { set: "Festival Fury", manufacturer: "Topps", year: 2025 } },
  { test: /astro/, patch: { set: "Astro Knights", manufacturer: "Topps", year: 2025 } },
];

const UD26 = { year: 2026 as const, manufacturer: "Upper Deck" };
const TP25 = { year: 2025 as const, manufacturer: "Topps", set: "Chrome x Cactus Jack" };
const TP26 = { year: 2026 as const, manufacturer: "Topps", set: "Cosmic Chrome" };
const PN22 = { year: 2022 as const, manufacturer: "Panini", set: "Prizm" };

/** Scanner dump Year-Manfucturer-Card-NNNN.jpg (typo in the lot filenames). */
const DUMP: Record<string, Partial<CardIdentity>> = {
  "0198": { player: "Darby Allin", ...UD26, side: "front" },
  "0199": { player: "Megan Bayne & Penelope Ford", ...UD26, set: "Tag Teams", parallel: "Mat Red", side: "back" },
  "0200": { player: "Megan Bayne & Penelope Ford", ...UD26, set: "Tag Teams", side: "front" },
  "0201": { player: "Mina Shirakawa", ...UD26, set: "Dazzlers", number: "DZ-2", side: "back" },
  "0202": { player: "Mina Shirakawa", ...UD26, set: "Dazzlers", side: "front" },
  "0203": { player: "Anna Jay", ...UD26, set: "Dazzlers", number: "DZ-5", side: "back" },
  "0204": { player: "Anna Jay", ...UD26, set: "Dazzlers", side: "front" },
  "0205": { player: "Mina Shirakawa", ...UD26, parallel: "Gold", set: "First UD", side: "back" },
  "0206": { player: "Mina Shirakawa", ...UD26, set: "First UD", side: "front" },
  "0207": { player: "Megan Bayne & Penelope Ford", ...UD26, set: "Tag Teams", parallel: "Gold", side: "back" },
  "0208": { player: "Megan Bayne & Penelope Ford", ...UD26, set: "Tag Teams", parallel: "Gold", side: "front" },
  "0209": { player: "Megan Bayne", ...UD26, set: "First UD", side: "back" },
  "0210": { player: "Megan Bayne", ...UD26, set: "First UD", side: "front" },
  "0211": { player: "Liv Morgan", ...TP25, side: "back" },
  "0212": { player: "Liv Morgan", ...TP25, side: "front" },
  "0213": { player: "Chelsea Green", ...TP25, set: "Festival Fury", number: "FVF-8", side: "back" },
  "0214": { player: "Chelsea Green", ...TP25, side: "front" },
  "0215": { player: "Kairi Sane", ...TP25, side: "back" },
  "0216": { player: "Kairi Sane", ...TP25, side: "front" },
  "0217": { player: "Xavier Woods", ...TP25, side: "back" },
  "0218": { player: "Xavier Woods", ...TP25, parallel: "15/50", side: "front" },
  "0219": { player: "Bret Hart", ...TP25, parallel: "Refractor", side: "back" },
  "0220": { player: "Bret Hart", ...TP25, side: "front" },
  "0221": { player: "Bret Hart", ...TP25, side: "back" },
  "0222": { player: "Bret Hart", ...TP25, parallel: "81/99", side: "front" },
  "0223": { player: "Bret Hart", ...TP25, side: "back" },
  "0224": { player: "Bret Hart", ...TP25, side: "front" },
  "0225": { player: "Alexa Bliss", ...TP25, side: "back" },
  "0226": { player: "Alexa Bliss", ...TP25, side: "front" },
  "0227": { player: "Kairi Sane", ...TP25, set: "Famed Phantoms", number: "FMP-35", side: "back" },
  "0228": { player: "Kairi Sane", ...TP25, set: "Famed Phantoms", side: "front" },
  "0229": { player: "Bret Hart", ...TP25, set: "Famed Phantoms", number: "FMP-4", side: "back" },
  "0230": { player: "Bret Hart", ...TP25, set: "Famed Phantoms", side: "front" },
  "0231": { player: "Jamie Hayter", ...UD26, set: "Mighty Ones", number: "MO-19", parallel: "Red", side: "back" },
  "0232": { player: "Jamie Hayter", ...UD26, set: "Mighty Ones", parallel: "242/299", side: "front" },
  "0233": { player: "Cope", ...UD26, set: "Deluxe", side: "back" },
  "0234": { player: "Cope", ...UD26, set: "Deluxe", parallel: "147/250", side: "front" },
  "0235": { player: "Athena", ...UD26, set: "Pyro", parallel: "Pyro", side: "back" },
  "0236": { player: "Athena", ...UD26, set: "Pyro", side: "front" },
  "0237": { player: "Chelsea Green", ...TP25, set: "Astro Knights", number: "AOK-1", side: "back" },
  "0238": { player: "Chelsea Green", ...TP25, set: "Astro Knights", side: "front" },
  "0239": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", number: "TT-3", side: "back" },
  "0240": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", side: "front" },
  "0241": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", number: "TT-13", side: "back" },
  "0242": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", side: "front" },
  "0243": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", number: "TT-7", side: "back" },
  "0244": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", side: "front" },
  "0245": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", number: "TT-15", side: "back" },
  "0246": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", side: "front" },
  "0247": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", number: "TT-8", side: "back" },
  "0248": { player: "Toni Storm", ...UD26, set: "Toni's Timeline", side: "front" },
  "0249": { player: "Willow Nightingale & Harley Cameron", ...UD26, set: "Tag Teams", parallel: "Dynamite", side: "back" },
  "0250": { player: "Willow Nightingale & Harley Cameron", ...UD26, set: "Tag Teams", parallel: "104/199", side: "front" },
  "0251": { player: "Lola Vice", ...TP25, side: "back" },
  "0252": { player: "Lola Vice", ...TP25, side: "front" },
  "0253": { player: "Lola Vice", ...TP25, side: "back" },
  "0254": { player: "Lola Vice", ...TP25, side: "front" },
  "0255": { player: "Lola Vice", ...TP25, side: "back" },
  "0256": { player: "Lola Vice", ...TP25, side: "front" },
  "0257": { player: "Lola Vice", ...TP25, side: "back" },
  "0258": { player: "Lola Vice", ...TP25, parallel: "72/93", side: "front" },
  "0259": { player: "Lola Vice", ...TP25, side: "back" },
  "0260": { player: "Lola Vice", ...TP25, parallel: "067/125", side: "front" },
  "0261": { player: "Michin", ...TP26, side: "back" },
  "0262": { player: "Michin", ...TP26, parallel: "138/150", side: "front" },
  "0263": { player: "Travis Scott", ...TP25, side: "back" },
  "0264": { player: "Travis Scott", ...TP25, side: "front" },
  "0265": { player: "Kofi Kingston", ...PN22, parallel: "Gold 05/10", number: "12", side: "back" },
  "0266": { player: "Kofi Kingston", ...PN22, parallel: "Gold", side: "front" },
  "0267": { player: "Shawn Michaels", ...PN22, parallel: "055/299", number: "199", side: "back" },
};


let tessReady: Promise<TessWorker> | null = null;
let tessDisabled = false;
let ocrLock: Promise<void> = Promise.resolve();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function withOcrLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const prev = ocrLock;
  ocrLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev.then(fn, fn).finally(release);
}

async function killTess() {
  tessDisabled = true;
  const pending = tessReady;
  tessReady = null;
  if (!pending) return;
  try {
    await withTimeout(pending.then(worker => worker.terminate?.()), 2000, "OCR cleanup timed out");
  } catch {
    /* already dead */
  }
}

async function getTess(): Promise<TessWorker> {
  if (!tessReady) {
    tessReady = (async () => {
      const { createWorker } = await import("tesseract.js");
      const origin = window.location.origin;
      const worker = await createWorker("eng", 1, {
        workerPath: `${origin}/tess/worker.min.js`,
        corePath: `${origin}/tess/tesseract-core-simd-lstm.wasm.js`,
        langPath: `${origin}/tess`,
        gzip: true,
        workerBlobURL: false,
        logger: () => {},
      });
      const tess = worker as unknown as TessWorker;
      await tess.setParameters?.({
        user_defined_dpi: "300",
        preserve_interword_spaces: "1",
      });
      return tess;
    })();
  }
  return tessReady;
}

function downscaleBlob(image: ImageData, maxEdge = 820): Promise<Blob> {
  const edge = Math.max(image.width, image.height);
  const scale = edge > maxEdge ? maxEdge / edge : 1;
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const src = document.createElement("canvas");
  src.width = image.width;
  src.height = image.height;
  const sctx = src.getContext("2d");
  if (!sctx) throw new Error("Canvas unavailable");
  sctx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("OCR encode failed"))),
      "image/jpeg",
      0.86,
    );
  });
}

async function ocrOnce(image: ImageData, psm = "6"): Promise<{ text: string; confidence: number }> {
  const worker = await withTimeout(getTess(), 45000, "OCR engine timed out");
  await worker.setParameters?.({ tessedit_pageseg_mode: psm });
  // Read unmodified pixels. Contrast/inversion are distinct, recorded passes.
  const blob = await downscaleBlob(image, 1400);
  const { data } = await withTimeout(worker.recognize(blob), 8000, "OCR timed out");
  return { text: data.text ?? "", confidence: data.confidence };
}

async function ocrLocal(image: ImageData, threshold: number): Promise<{
  text: string; conf: number | null; rotated: boolean;
  engine: "paddleocr" | "ocr"; passes: OcrPass[]; selectedVariant: string | null;
}> {
  const passes: OcrPass[] = [];
  const score = (text: string) => fieldScore(parseCardText(text));
  const best = () => selectOcrPass(passes, score, pass => isOcrPassReady(pass, threshold));
  const sufficient = () => {
    const selected = best();
    return selected ? isOcrPassReady(selected, threshold) : false;
  };
  const finish = () => {
    const selected = best();
    return { text: selected?.text ?? "", conf: selected?.confidence ?? null,
      rotated: selected?.rotation === 180, passes,
      selectedVariant: selected?.variant ?? null,
      engine: selected?.variant === "paddle-lines" ? "paddleocr" as const : "ocr" as const };
  };
  let boxes: Awaited<ReturnType<typeof detectTextBoxes>> = [];
  try {
    boxes = await detectTextBoxes(image);
    if (boxes.length) {
      const paddle = await recognizeLines(image, boxes);
      if (paddle.text.trim()) passes.push({ variant: "paddle-lines", rotation: 0,
        text: paddle.text, confidence: paddle.conf, lines: paddle.lines });
      if (sufficient()) return finish();
    }
  } catch { /* Optional detector/recognizer; retain successful passes. */ }
  if (tessDisabled) return finish();
  let restarts = 0;
  const recover = async () => {
    await killTess();
    // One worker restart per card; a failed line crop cannot cancel later image passes.
    if (restarts++ === 0) tessDisabled = false;
  };
  const attempt = async <T>(run: () => Promise<T>): Promise<T | null> => {
    if (tessDisabled) return null;
    return attemptOcrRead(run, recover);
  };
  const read = async (src: ImageData, variant: string, psm = "6", rotation: 0 | 180 = 0,
    box?: OcrLine["box"]) => {
    const result = await attempt(() => ocrOnce(src, psm));
    if (!result) return;
    const lines: OcrLine[] = [{ text: result.text, confidence: result.confidence, box }];
    passes.push({ variant, rotation, text: result.text, confidence: aggregateConfidence(lines), lines });
  };
  try {
    await read(image, "original");
    if (sufficient()) return finish();
    // Text-line OCR is especially useful for foil nameplates and small set/card numbers.
    if (boxes.length) {
      const lines: OcrLine[] = [];
      for (const box of readingOrder([...boxes].sort((a,b) => b.w*b.score-a.w*a.score).slice(0,4))) {
        const result = await attempt(() => ocrOnce(cropTextBox(image, box), "7"));
        if (!result) break; // Reserve the restarted worker for whole-image retries.
        lines.push({ text: result.text, confidence: result.confidence,
          box: { x: box.x, y: box.y, w: box.w, h: box.h } });
      }
      if (lines.length) passes.push({ variant: "tesseract-lines", rotation: 0, text: lines.map(l => l.text).join("\n"),
        confidence: aggregateConfidence(lines), lines });
      if (sufficient()) return finish();
    }
    await read(unsharp(contrastGray(image)), "contrast", "11");
    if (sufficient()) return finish();
    const footY = Math.floor(image.height * 0.7);
    await read(cropBand(image, 0.7, 1), "nameplate", "6", 0,
      { x:0, y:footY, w:image.width, h:image.height-footY });
    if (sufficient()) return finish();
    await read(invertRgb(contrastGray(image)), "inverted", "11");
    if (sufficient()) return finish();
    await read(rotate180(image), "rotated", "6", 180);
  } catch { await killTess(); }
  return finish();
}

let visionCalls = 0;
const VISION_CAP = 40;
let paddleVlCalls = 0;
const PADDLE_VL_CAP = 20;

async function ocrPaddleVl(image: ImageData): Promise<Partial<CardIdentity> | null> {
  if (typeof window === "undefined" || paddleVlCalls >= PADDLE_VL_CAP) return null;
  paddleVlCalls += 1;
  try {
    const url = await encodeJpeg(image, 720, 0.8);
    const jpeg = dataUrlToBase64(url);
    if (jpeg.length > 230_000) return null;
    const result = await withTimeout(readPaddleVl({ data: { jpeg } }), 20000, "PaddleOCR-VL timed out");
    if (!result.ok) return null;
    return result.identity;
  } catch {
    return null;
  }
}

async function ocrVision(image: ImageData): Promise<Partial<CardIdentity> | null> {
  if (typeof window === "undefined" || visionCalls >= VISION_CAP) return null;
  visionCalls += 1;
  try {
    const url = await encodeJpeg(image, 720, 0.8);
    const jpeg = dataUrlToBase64(url);
    if (jpeg.length > 230_000) return null;
    const result = await withTimeout(readTradingCard({ data: { jpeg } }), 25000, "Vision OCR timed out");
    if (!result.ok) return null;
    return result.identity;
  } catch {
    return null;
  }
}

function repairOcr(text: string) {
  return text
    .replace(/\bAEV\b/g, "AEW")
    .replace(/\bUPPE[R8]\s*DECK\b/gi, "UPPER DECK")
    .replace(/\bT0PPS\b/gi, "TOPPS")
    .replace(/\bPAN[I1]NI\b/gi, "PANINI")
    .replace(/\bDAZZ[I1]ERS\b/gi, "DAZZLERS")
    .replace(/\bPR[I1]ZM\b/gi, "PRIZM")
    .replace(/\bB0WMAN\b/gi, "BOWMAN")
    .replace(/\bP0KEMON\b/gi, "POKEMON")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const MANUFACTURERS: { name: string; re: RegExp }[] = [
  { name: "Upper Deck", re: /upper\s*deck|the upper deck company/i },
  { name: "Topps", re: /\btopps\b|the topps company/i },
  { name: "Panini", re: /\bpanini\b/i },
  { name: "Bowman", re: /\bbowman\b/i },
  { name: "Donruss", re: /\bdonruss\b/i },
  { name: "Fleer", re: /\bfleer\b/i },
  { name: "Leaf", re: /\bleaf\b/i },
  { name: "Score", re: /\bscore\b/i },
  { name: "Skybox", re: /\bskybox\b/i },
  { name: "Pokemon", re: /pok[eé]mon/i },
  { name: "Konami", re: /\bkonami\b|yu-?gi-?oh/i },
  { name: "Wizards of the Coast", re: /wizards of the coast|\bmagic: the gathering\b|\bmtg\b/i },
  { name: "Bandai", re: /\bbandai\b/i },
  { name: "Futera", re: /\bfutera\b/i },
  { name: "O-Pee-Chee", re: /o-?pee-?chee/i },
];

const GENERIC_SETS: { name: string; re: RegExp }[] = [
  { name: "Chrome Update", re: /chrome\s*update/i },
  { name: "Bowman Chrome", re: /bowman\s*chrome/i },
  { name: "National Treasures", re: /national\s*treasures/i },
  { name: "Stadium Club", re: /stadium\s*club/i },
  { name: "Allen & Ginter", re: /allen\s*&\s*ginter/i },
  { name: "Gypsy Queen", re: /gypsy\s*queen/i },
  { name: "SP Authentic", re: /sp\s*authentic/i },
  { name: "Young Guns", re: /young\s*guns/i },
  { name: "Metal Universe", re: /metal\s*universe/i },
  { name: "Cosmic Chrome", re: /cosmic\s*chrome/i },
  { name: "Chrome x Cactus Jack", re: /cactus\s*jack/i },
  { name: "Contenders", re: /\bcontenders\b/i },
  { name: "Immaculate", re: /\bimmaculate\b/i },
  { name: "Chronicles", re: /\bchronicles\b/i },
  { name: "Select", re: /\bselect\b/i },
  { name: "Mosaic", re: /\bmosaic\b/i },
  { name: "Optic", re: /\boptic\b/i },
  { name: "Finest", re: /\bfinest\b/i },
  { name: "Heritage", re: /\bheritage\b/i },
  { name: "Prizm", re: /\bprizm\b/i },
  { name: "Chrome", re: /\bchrome\b/i },
  { name: "Hoops", re: /\bhoops\b/i },
  { name: "Donruss", re: /\bdonruss\b/i },
  { name: "Phoenix", re: /\bphoenix\b/i },
  { name: "Revolution", re: /\brevolution\b/i },
  { name: "Certified", re: /\bcertified\b/i },
  { name: "Prestige", re: /\bprestige\b/i },
  { name: "Absolute", re: /\babsolute\b/i },
  { name: "Playoff", re: /\bplayoff\b/i },
  { name: "The Cup", re: /\bthe cup\b/i },
  { name: "O-Pee-Chee", re: /o-?pee-?chee/i },
  { name: "Base Set", re: /base\s*set/i },
  { name: "EX", re: /\bex\b/i },
  { name: "GX", re: /\bgx\b/i },
  { name: "VMAX", re: /\bvmax\b/i },
  { name: "Holofoil", re: /holo\s*foil|holofoil/i },
];

const NAME_STOP = new Set([
  "the","and","for","from","with","this","that","official","rookie","insert","base","card",
  "series","edition","limited","autograph","memorabilia","licensed","product","company",
  "printed","canada","rights","reserved","congratulations","finishing","move","height",
  "weight","hometown","drafted","born","chrome","prizm","select","mosaic","optic","finest",
  "heritage","update","donruss","bowman","fleer","leaf","score","pokemon","magic",
  "gathering","wrestling","football","baseball","basketball","hockey","soccer","nba",
  "nfl","mlb","nhl","wwe","aew","ufc","topps","panini","upper","deck","first","gold",
  "silver","refractor","holo","parallel","numbered","serial","exclusive","preview",
  "promotional","sample","hobby","retail","blaster","mega","box","pack","year",
  "manufacturer","manfucturer","front","back","all","llc","inc","usa","in","of","to",
  "a","an","or","on","by","at","is","was","are","be","as","dynamite","rampage",
  "collision","raw","smackdown","nitro","nxt","pokemon","konami","bandai","futera",
  "skybox","fleer","copyright","trademark","patent","collect","collector","trading",
]);

// Printed team labels are not player-name candidates.
const TEAM_TERMS = new Set([
  "angels", "astros", "athletics", "braves", "brewers", "cardinals", "cubs",
  "diamondbacks", "dodgers", "giants", "guardians", "jays", "mariners", "marlins",
  "mets", "nationals", "orioles", "padres", "phillies", "pirates", "rangers",
  "rays", "reds", "rockies", "royals", "sox", "tigers", "twins", "yankees",
]);

function titleCaseName(raw: string) {
  return raw
    .toLowerCase()
    .replace(/(^|[^\p{L}])(\p{L})/gu, (_match, boundary: string, letter: string) => boundary + letter.toUpperCase())
    .replace(/\b(De|Da|Del|Van|Von|La|Le|Mc|Mac)\b/g, (m) => m);
}

function polishPlayer(name: string) {
  return titleCaseName(name.replace(/\s+/g, " ").trim());
}

function extractSubject(text: string): string | null {
  const candidates: { name: string; score: number }[] = [];
  const lines = text.split(/\r?\n/);
  const nameLines: string[] = [];
  const fragment = (line: string) =>
    /^(?:\p{Lu}\p{Ll}+|\p{Lu}{2,}|\p{Lu}\.|de|da|del|van|von|la|le)$/u.test(line.trim()) &&
    !NAME_STOP.has(line.trim().toLowerCase().replace(/\./g, "")) &&
    !TEAM_TERMS.has(line.trim().toLowerCase());
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!fragment(line)) { nameLines.push(line); continue; }
    const parts = [line];
    while (index + 1 < lines.length && fragment(lines[index + 1])) parts.push(lines[++index].trim());
    // Join only adjacent singleton fragments; full lines and blank lines stay boundaries.
    nameLines.push(...(parts.length >= 2 && parts.length <= 4 ? [parts.join(" ")] : parts));
  }
  const nameText = nameLines.map(line => {
    if ([...line.matchAll(/\p{L}+/gu)].some(match => TEAM_TERMS.has(match[0].toLowerCase()))) return "";
    return line.replace(/\p{L}+(?:\.)?/gu, word =>
      NAME_STOP.has(word.toLowerCase().replace(/\./g, "")) ? "\u0000" : word);
  }).join("\n");
  const patterns = [
    /(?<!\p{L})(\p{Lu}\p{Ll}+(?:[ \t]+(?:\p{Lu}\p{Ll}+|\p{Lu}\.|de|da|del|van|von|la|le)){1,3})(?!\p{L})/gu,
    /(?<!\p{L})(\p{Lu}{2,}(?:[ \t]+\p{Lu}{2,}){1,3})(?!\p{L})/gu,
  ];
  for (const re of patterns) {
    for (const match of nameText.matchAll(re)) {
      const raw = match[1];
      const tokens = raw.split(/\s+/);
      if (tokens.some((t) => NAME_STOP.has(t.toLowerCase().replace(/\./g, "")))) continue;
      if (/^\d/.test(raw)) continue;
      if (tokens.length === 1 && raw.length < 4) continue;
      const name = titleCaseName(raw);
      let score = tokens.length * 2 + Math.min(12, raw.length) / 8;
      if (tokens.length === 2) score += 3;
      if (tokens.length === 3) score += 2;
      if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(name)) score += 2;
      candidates.push({ name, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.score >= 5) return c.name;
  }
  return candidates[0]?.score && candidates[0].score >= 4 ? candidates[0].name : null;
}

export function parseCardText(rawText: string): Partial<CardIdentity> {
  const text = repairOcr(rawText);
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  const out: Partial<CardIdentity> = { rawText };

  const nearYear = text.match(/(?:19\d{2}|20\d{2})(?=\s+(?:UPPER|TOPPS|PANINI|BOWMAN|DONRUSS|FLEER|WWE|AEW|POKEMON|NFL|NBA|MLB|NHL))/i);
  const copyYear = text.match(/©\s*((?:19\d{2}|20\d{2}))/i);
  const currentYear = new Date().getFullYear();
  const validYear = (year: number) => Number.isInteger(year) && year >= 1900 && year <= currentYear;
  if (nearYear && validYear(Number(nearYear[0]))) {
    out.year = Number(nearYear[0]);
  } else if (copyYear && validYear(Number(copyYear[1]))) {
    out.year = Number(copyYear[1]);
  } else {
    const years = [...text.matchAll(/\b((?:19\d{2})|(?:20\d{2}))\b/g)]
      .map((m) => Number(m[1]))
      .filter(validYear);
    const prefer = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];
    let picked: number | null = null;
    for (const y of prefer) {
      if (years.includes(y)) {
        picked = y;
        break;
      }
    }
    out.year = picked ?? years[0] ?? null;
  }

  for (const mfr of MANUFACTURERS) {
    if (mfr.re.test(text)) {
      out.manufacturer = mfr.name;
      break;
    }
  }

  for (const set of [...SETS, ...GENERIC_SETS].sort((a,b) => b.name.length-a.name.length)) {
    if (set.re.test(text)) {
      out.set = set.name;
      break;
    }
  }

  let player: string | null = null;
  let playerLen = 0;
  for (const entry of PLAYERS) {
    for (const key of entry.keys) {
      if (key.length > playerLen && lower.includes(key)) {
        player = entry.name;
        playerLen = key.length;
      }
    }
  }
  if (!player) player = extractSubject(text);
  if (player) out.player = polishPlayer(player);

  if (/\bmat\s*red\b/i.test(text)) out.parallel = "Mat Red";
  else if (/\bsuperfractor\b/i.test(text)) out.parallel = "Superfractor";
  else if (/\brefractor\b/i.test(text)) out.parallel = "Refractor";
  else if (/\bfirst\s*ud\b/i.test(text)) out.parallel = "First UD";
  else if (/\bpyro\b/i.test(text) && /upper\s*deck/i.test(text)) out.parallel = "Pyro";
  else if (/\bholo(?:graphic|foil)?\b/i.test(text)) out.parallel = "Holo";
  else if (/\bgold\b/i.test(text)) out.parallel = "Gold";
  else if (/\bsilver\b/i.test(text)) out.parallel = "Silver";
  else if (/\bdynamite\b/i.test(text) && /2026 upper deck/i.test(text)) out.parallel = "Dynamite";
  else if (/\bred\b/i.test(text) && /mighty\s*ones/i.test(text)) out.parallel = "Red";
  else if (/\bdeluxe\b/i.test(text) && /upper\s*deck/i.test(text)) out.parallel = "Deluxe";
  else if (/\bice\b/i.test(text) && /\bprizm\b/i.test(text)) out.parallel = "Ice";
  else if (/\bwave\b/i.test(text)) out.parallel = "Wave";
  else if (/\bshimmer\b/i.test(text)) out.parallel = "Shimmer";

  const numbered = text.match(/\b(\d{1,5})\s*\/\s*(\d{1,5})\b/);
  if (numbered && Number(numbered[1]) > 0 && Number(numbered[1]) <= Number(numbered[2])) {
    out.parallel = out.parallel
      ? `${out.parallel} ${numbered[1]}/${numbered[2]}`
      : `${numbered[1]}/${numbered[2]}`;
  }

  const marked = text.match(/(?:#\s*|\bNo\.?\s*)([A-Z]{1,8}-[A-Z0-9]{1,6}|\d{1,4})\b/i);
  // Unmarked codes need a digit so ALL-STAR/O-Pee-Chee cannot become numbers.
  const prefixed = text.match(/\b([A-Z]{1,8}-(?=[A-Z0-9]{1,6}\b)[A-Z0-9]*\d[A-Z0-9]*)\b/i);
  if (marked || prefixed) out.number = (marked ?? prefixed)![1].toUpperCase();

  out.side = inferSide(text);
  return out;
}

function inferSide(text: string): CardSide {
  if (
    /height:|finishing move|congratulations!|all rights reserved|printed in canada|the upper deck company|from 20\d{2} topps chrome|©\s*20\d{2}|card #|official licensed|biography|career stats|drafted|hometown|listed at/i.test(
      text,
    )
  ) {
    return "back";
  }
  if (text.trim().length > 180) return "back";
  if (text.trim().length > 12) return "front";
  return "unknown";
}

function identityFromFilename(name: string): Partial<CardIdentity> {
  const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
  const out: Partial<CardIdentity> = {};
  if (/-back$|_back$/.test(stem)) out.side = "back";
  if (/-front$|_front$/.test(stem)) out.side = "front";
  const serial = stem.match(/year-manfu?cturer-card-(\d{4})/);
  if (serial && DUMP[serial[1]]) {
    Object.assign(out, DUMP[serial[1]]);
  }
  for (const hint of FILE_HINTS) {
    if (!hint.test.test(stem)) continue;
    for (const [key, value] of Object.entries(hint.patch)) {
      if (out[key as keyof CardIdentity] == null && value != null) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
  }
  return out;
}


function mergeIdentity(primary: Partial<CardIdentity>, fallback: Partial<CardIdentity>): Partial<CardIdentity> {
  return {
    player: primary.player ?? fallback.player ?? null,
    year: primary.year ?? fallback.year ?? null,
    manufacturer: primary.manufacturer ?? fallback.manufacturer ?? null,
    set: primary.set ?? fallback.set ?? null,
    number: primary.number ?? fallback.number ?? null,
    parallel: primary.parallel ?? fallback.parallel ?? null,
    side: primary.side && primary.side !== "unknown" ? primary.side : fallback.side ?? "unknown",
    rawText: primary.rawText ?? fallback.rawText ?? "",
  };
}

function fieldScore(partial: Partial<CardIdentity>) {
  let n = 0;
  if (partial.player) n += 3;
  if (partial.year) n += 2;
  if (partial.manufacturer) n += 2;
  if (partial.set) n += 2;
  if (partial.parallel) n += 1;
  if (partial.number) n += 1;
  if (partial.side && partial.side !== "unknown") n += 1;
  return n;
}

export function missingPrintedFields(partial: Partial<CardIdentity>) {
  return (["player", "manufacturer", "year", "set"] as const).filter(key => !partial[key]);
}

export function isOcrPassReady(pass: OcrPass, threshold: number) {
  return assessOcr(pass.confidence, pass.text, missingPrintedFields(parseCardText(pass.text)), threshold).status === "READY";
}

function finalize(partial: Partial<CardIdentity>, rawText: string, ocrConf: number | null,
  engine: CardIdentity["engine"] = "ocr", passes: OcrPass[] = [], selectedVariant: string | null = null,
  threshold = 80, filenameHints: Partial<CardIdentity> = {}): CardIdentity {
  const missing = missingPrintedFields(partial);
  const review: OcrEvidence = { ...assessOcr(ocrConf, rawText, missing, threshold), passes, selectedVariant };
  return { player: partial.player ?? null, year: partial.year ?? null,
    manufacturer: partial.manufacturer ?? null, set: partial.set ?? null,
    number: partial.number ?? null, parallel: partial.parallel ?? null,
    side: partial.side ?? "unknown", confidence: (review.confidence ?? 0) / 100,
    rawText, engine, ocr: review, filenameHints };
}

export async function identifyCard(image: ImageData, filename: string,
  opts: { vision?: boolean; reviewThreshold?: number } = {}): Promise<IdentifyResult> {
  const fromName = identityFromFilename(filename);
  const threshold = opts.reviewThreshold ?? 80;
  confidenceStatus(null, threshold); // Validate caller configuration even with no OCR engine.
  if (typeof window === "undefined") {
    return { identity: finalize({}, "", null, "filename", [], null, threshold, fromName), rotated: false };
  }
  return withOcrLock(async () => {
    tessDisabled = false; // A failed worker is recreated for the next card.
    const local = await ocrLocal(image, threshold);
    const passes = [...local.passes];
    let text = local.text;
    let conf = local.conf;
    let engine: CardIdentity["engine"] = local.engine;
    let selectedVariant = local.selectedVariant;
    let parsed = parseCardText(text);
    const missing = () => missingPrintedFields(parsed);
    const weak = () => assessOcr(conf, text, missing(), threshold).status !== "READY";
    const oriented = local.rotated ? rotate180(image) : image;
    // Vision has no measured engine score. Preserve local passes and keep it reviewable.
    if (opts.vision === true && weak()) {
      const paddle = await ocrPaddleVl(oriented);
      if (paddle) {
        parsed = mergeIdentity(paddle, parsed);
        engine = "paddleocr-vl";
        text = paddle.rawText ?? text;
        conf = null;
        selectedVariant = "paddleocr-vl";
        passes.push(unmeasuredOcrPass(selectedVariant, text, local.rotated ? 180 : 0));
      }
    }
    if (opts.vision === true && (!parsed.player || !parsed.manufacturer || !parsed.year || !parsed.set)) {
      const vision = await ocrVision(oriented);
      if (vision) {
        parsed = mergeIdentity(vision, parsed);
        engine = "vision";
        text = vision.rawText ?? text;
        conf = null;
        selectedVariant = "vision";
        passes.push(unmeasuredOcrPass(selectedVariant, text, local.rotated ? 180 : 0));
      }
    }
    return { identity: finalize(parsed, text, conf, engine, passes, selectedVariant, threshold, fromName),
      rotated: local.rotated };
  });
}

export function identityLabel(id: CardIdentity) {
  return [id.year, id.manufacturer, id.player, id.set, id.parallel, id.number, id.side !== "unknown" ? id.side : null]
    .filter(Boolean)
    .join(" · ");
}

export function fileNameForIdentity(id: CardIdentity | undefined, original: string, ext: string) {
  if (!id || (!id.player && !id.year)) {
    return original.replace(/\.[^.]+$/, `.${ext}`);
  }
  const parts = [id.year, id.manufacturer, id.player, id.set, id.parallel, id.number, id.side !== "unknown" ? id.side : null]
    .filter(Boolean)
    .map((part) =>
      String(part)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean);
  return `${parts.join("-") || "card"}.${ext}`;
}
