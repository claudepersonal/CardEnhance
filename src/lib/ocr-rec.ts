/**
 * PP-OCRv5 English mobile recognition (CTC).
 * Input [1,3,48,W] BGR [0,1]. Output [T,1,438] or [1,T,438].
 */

import { createSession, getOrt, withTimeout, type OrtSession } from "./ort";
import type { TextBox } from "./ocr-det";
import { aggregateConfidence, recognitionSize, type OcrLine } from "./ocr-quality";

const HEIGHT = 48;
const MAX_W = 1280; // Model exposes a dynamic width; keep foil/nameplate glyphs at 48px.
let sessionReady: Promise<OrtSession | null> | null = null;
let recDisabled = false;
let charset: string[] | null = null;

async function loadCharset() {
  if (charset) return charset;
  const res = await fetch(`${window.location.origin}/ocr/en_ppocrv5_charset.json`);
  if (!res.ok) throw new Error("charset missing");
  charset = (await res.json()) as string[];
  return charset;
}

async function getSession() {
  if (recDisabled) return null;
  if (!sessionReady) {
    sessionReady = (async () => {
      try {
        return await createSession(`${window.location.origin}/ocr/en_ppocrv5_mobile_rec.onnx`, 20000);
      } catch {
        recDisabled = true;
        return null;
      }
    })();
  }
  return sessionReady;
}

function cropBox(src: ImageData, box: TextBox): ImageData {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(src.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(src.height, Math.ceil(box.y + box.h));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcOff = ((y0 + y) * src.width + x0) * 4;
    out.data.set(src.data.subarray(srcOff, srcOff + w * 4), y * w * 4);
  }
  return out;
}

function toRecTensor(src: ImageData): { tensor: Float32Array; width: number } {
  const size = recognitionSize(src.width, src.height, HEIGHT, MAX_W);
  const tw = size.paddedWidth;
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const tmp = document.createElement("canvas");
  tmp.width = src.width;
  tmp.height = src.height;
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("Canvas unavailable");
  tctx.putImageData(src, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, tw, HEIGHT);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, size.width, size.height);
  const pix = ctx.getImageData(0, 0, tw, HEIGHT).data;
  const plane = tw * HEIGHT;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const r = pix[i * 4] / 255;
    const g = pix[i * 4 + 1] / 255;
    const b = pix[i * 4 + 2] / 255;
    tensor[i] = (b - 0.5) / 0.5;
    tensor[plane + i] = (g - 0.5) / 0.5;
    tensor[2 * plane + i] = (r - 0.5) / 0.5;
  }
  return { tensor, width: tw };
}

function ctcDecode(data: Float32Array, dims: number[], dict: string[]): { text: string; conf: number } {
  let t = 0;
  let classes = 438;
  let layout: "tnc" | "ntc" = "ntc";
  if (dims.length === 3 && dims[2] === dict.length) {
    if (dims[0] === 1) {
      t = dims[1];
      classes = dims[2];
      layout = "ntc";
    } else {
      t = dims[0];
      classes = dims[2];
      layout = "tnc";
    }
  } else if (dims.length === 2) {
    t = dims[0];
    classes = dims[1];
    layout = "tnc";
  } else {
    return { text: "", conf: 0 };
  }
  const at = (step: number, cls: number) => {
    if (layout === "ntc") return data[step * classes + cls];
    return data[step * classes + cls];
  };
  let last = 0;
  let text = "";
  let score = 0;
  let n = 0;
  for (let i = 0; i < t; i++) {
    let best = 0;
    let bi = 0;
    for (let c = 0; c < classes; c++) {
      const v = at(i, c);
      if (v > best) {
        best = v;
        bi = c;
      }
    }
    if (bi !== 0 && bi !== last) {
      text += dict[bi] ?? "";
      score += best;
      n++;
    }
    last = bi;
  }
  return { text: text.trim(), conf: n ? (score / n) * 100 : 0 };
}

export async function recognizeLines(src: ImageData, boxes: TextBox[]): Promise<{ text: string; conf: number | null; lines: OcrLine[] }> {
  if (typeof window === "undefined" || recDisabled) return { text: "", conf: null, lines: [] };
  const session = await getSession();
  if (!session) return { text: "", conf: null, lines: [] };
  const dict = await loadCharset();
  const ort = await getOrt();
  const lines: OcrLine[] = [];
  const ordered = [...boxes].sort((a, b) => (Math.abs(a.y - b.y) > Math.max(8, a.h * 0.6) ? a.y - b.y : a.x - b.x));
  for (const box of ordered.slice(0, 24)) {
    if (box.w < 8 || box.h < 8) continue;
    try {
      const crop = cropBox(src, box);
      const { tensor, width } = toRecTensor(crop);
      const input = new ort.Tensor("float32", tensor, [1, 3, HEIGHT, width]);
      const feeds: Record<string, unknown> = {};
      feeds[session.inputNames[0] ?? "x"] = input;
      const result = await withTimeout(session.run(feeds), 4000, "rec timeout");
      const name = session.outputNames[0] ?? Object.keys(result)[0];
      const out = name ? result[name] : undefined;
      if (!out) continue;
      const decoded = ctcDecode(out.data as Float32Array, out.dims, dict);
      if (decoded.text.length >= 2) {
        lines.push({ text: decoded.text, confidence: decoded.conf, box: { x: box.x, y: box.y, w: box.w, h: box.h } });
      }
    } catch {
      /* next line */
    }
  }
  return { text: lines.map(line => line.text).join("\n"), conf: aggregateConfidence(lines), lines };
}
