/**
 * YOLO26n (Ultralytics, Jan 2026) NMS-free card locator.
 * Fine-tuned 1-class card-det.onnx is preferred when present.
 * End-to-end one-to-one head → output [1, 300, 6] = [x1,y1,x2,y2,conf,class]
 * in 640 letterbox pixels. YOLOv8 / YOLO11 detect: [1, 4+C, N].
 */

import { createSession, getOrt, withTimeout, type OrtSession } from "./ort";
import { letterboxGeometry, unletterboxBox } from "./yolo-geometry";

export type YoloBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  classId: number;
  label: string;
};

export type YoloCrop = {
  image: ImageData;
  cropped: boolean;
  box: YoloBox | null;
  engine: "yolo26" | "yolo" | "card" | null;
};

const INPUT = 640;
const CONF = 0.15;
const IOU = 0.45;
const CARD_CLASSES = new Set([62, 63, 64, 65, 66, 67, 73, 26, 28, 39, 41, 45, 46, 74, 75]);
const PERSON = 0;

const COCO = [
  "person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light",
  "fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow",
  "elephant","bear","zebra","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee",
  "skis","snowboard","sports ball","kite","baseball bat","baseball glove","skateboard","surfboard",
  "tennis racket","bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple",
  "sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair","couch",
  "potted plant","bed","dining table","toilet","tv","laptop","mouse","remote","keyboard",
  "cell phone","microwave","oven","toaster","sink","refrigerator","book","clock","vase",
  "scissors","teddy bear","hair drier","toothbrush",
];

let sessionReady: Promise<{ session: OrtSession; kind: "yolo26" | "yolo" | "card" } | null> | null = null;
let cocoReady: Promise<{ session: OrtSession; kind: "yolo26" | "yolo" } | null> | null = null;
let yoloDisabled = false;

async function getSession() {
  if (yoloDisabled) return null;
  if (!sessionReady) {
    sessionReady = (async () => {
      const origin = window.location.origin;
      const candidates = [
        [`${origin}/models/card-det.onnx`, "card"],
        [`${origin}/models/yolo26n.onnx`, "yolo26"],
        [`${origin}/models/yolov8n.onnx`, "yolo"],
      ] as const;
      for (const [url, kind] of candidates) {
        try {
          const session = await createSession(url, 25000);
          return { session, kind };
        } catch {
          /* try next weight file */
        }
      }
      yoloDisabled = true;
      return null;
    })();
  }
  return sessionReady;
}

async function getCocoSession() {
  if (!cocoReady) {
    cocoReady = (async () => {
      const origin = window.location.origin;
      try {
        const session = await createSession(`${origin}/models/yolo26n.onnx`, 25000);
        return { session, kind: "yolo26" as const };
      } catch {
        try {
          const session = await createSession(`${origin}/models/yolov8n.onnx`, 25000);
          return { session, kind: "yolo" as const };
        } catch {
          return null;
        }
      }
    })();
  }
  return cocoReady;
}

function letterbox(src: ImageData) {
  const { width: W, height: H } = src;
  const geometry = letterboxGeometry(W, H, INPUT);
  const canvas = document.createElement("canvas");
  canvas.width = INPUT;
  canvas.height = INPUT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT, INPUT);
  const tmp = document.createElement("canvas");
  tmp.width = W;
  tmp.height = H;
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("Canvas unavailable");
  tctx.putImageData(src, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tmp, geometry.padX, geometry.padY, geometry.width, geometry.height);
  const pix = ctx.getImageData(0, 0, INPUT, INPUT).data;
  const tensor = new Float32Array(3 * INPUT * INPUT);
  const plane = INPUT * INPUT;
  for (let i = 0; i < plane; i++) {
    tensor[i] = pix[i * 4] / 255;
    tensor[plane + i] = pix[i * 4 + 1] / 255;
    tensor[2 * plane + i] = pix[i * 4 + 2] / 255;
  }
  return { tensor, geometry };
}

function iou(a: YoloBox, b: YoloBox) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function nms(boxes: YoloBox[], limit = 16): YoloBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: YoloBox[] = [];
  for (const box of sorted) {
    if (keep.length >= limit) break;
    if (keep.every((k) => iou(k, box) < IOU)) keep.push(box);
  }
  return keep;
}

function pushBox(
  boxes: YoloBox[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  score: number,
  cls: number,
  scale: number,
  W: number,
  H: number,
  isCardModel: boolean,
) {
  if (![x1,y1,x2,y2,score,cls].every(Number.isFinite) || score < CONF || score > 1) return;
  const x = Math.max(0, Math.min(x1, x2) / scale);
  const y = Math.max(0, Math.min(y1, y2) / scale);
  const w = Math.min(W, Math.max(x1, x2) / scale) - x;
  const h = Math.min(H, Math.max(y1, y2) / scale) - y;
  if (w < 8 || h < 8) return;
  boxes.push({
    x,
    y,
    w,
    h,
    score,
    classId: cls,
    // Only the fine-tuned single-class card model may emit the "card" label.
    // For COCO models class 0 is "person" and must keep that label so the
    // PERSON guard in cardFitnessSheet/cardFitness rejects it.
    label: isCardModel ? "card" : (COCO[cls] ?? String(cls)),
  });
}

function decodeYolo26(data: Float32Array | number[], dims: number[], scale: number, W: number, H: number, isCardModel: boolean): YoloBox[] {
  const boxes: YoloBox[] = [];
  let n = 0;
  let stride = 6;
  let layout: "row" | "col" = "row";
  if (dims.length === 3 && dims[2] === 6) {
    n = dims[1];
    stride = 6;
    layout = "row";
  } else if (dims.length === 3 && dims[1] === 6) {
    n = dims[2];
    stride = dims[2];
    layout = "col";
  } else if (dims.length === 2 && dims[1] === 6) {
    n = dims[0];
    stride = 6;
    layout = "row";
  } else {
    return boxes;
  }
  const at = (i: number, c: number) =>
    Number(layout === "row" ? data[i * stride + c] : data[c * stride + i]);
  for (let i = 0; i < n; i++) {
    const score = at(i, 4);
    if (score < CONF) continue;
    const cls = Math.round(at(i, 5));
    pushBox(boxes, at(i, 0), at(i, 1), at(i, 2), at(i, 3), score, cls, scale, W, H, isCardModel);
  }
  return boxes;
}

function decodeYolo8(data: Float32Array | number[], dims: number[], scale: number, W: number, H: number, isCardModel: boolean): YoloBox[] {
  const boxes: YoloBox[] = [];
  let preds: number;
  let stride: number;
  let channels: number;
  let layout: "cfirst" | "clast";
  if (dims.length === 3 && dims[1] > 4 && dims[1] < 200 && dims[2] > dims[1]) {
    channels = dims[1];
    preds = dims[2];
    stride = dims[2];
    layout = "cfirst";
  } else if (dims.length === 3 && dims[2] > 4 && dims[2] < 200) {
    channels = dims[2];
    preds = dims[1];
    stride = dims[2];
    layout = "clast";
  } else if (dims.length === 2 && dims[1] > 4 && dims[1] < 200) {
    channels = dims[1];
    preds = dims[0];
    stride = dims[1];
    layout = "clast";
  } else {
    return boxes;
  }
  const ncls = channels - 4;
  const at = (channel: number, i: number) =>
    Number(layout === "cfirst" ? data[channel * stride + i] : data[i * stride + channel]);
  for (let i = 0; i < preds; i++) {
    let best = 0;
    let cls = 0;
    for (let c = 0; c < ncls; c++) {
      const s = at(4 + c, i);
      if (s > best) {
        best = s;
        cls = c;
      }
    }
    if (best < CONF) continue;
    const cx = at(0, i);
    const cy = at(1, i);
    const bw = at(2, i);
    const bh = at(3, i);
    pushBox(boxes, cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2, best, cls, scale, W, H, isCardModel);
  }
  return nms(boxes);
}

export function decodeYoloOutput(
  output: { data: Float32Array | number[]; dims: number[] },
  scale: number,
  W: number,
  H: number,
  isCardModel: boolean,
): YoloBox[] {
  const { data, dims } = output;
  if (
    (dims.length === 3 && (dims[1] === 6 || dims[2] === 6)) ||
    (dims.length === 2 && dims[1] === 6)
  ) {
    return decodeYolo26(data, dims, scale, W, H, isCardModel);
  }
  return decodeYolo8(data, dims, scale, W, H, isCardModel);
}

function cardFitness(box: YoloBox, W: number, H: number) {
  if (box.classId === PERSON && box.label !== "card") return 0;
  const area = (box.w * box.h) / (W * H);
  if (area < 0.035 || area > 0.94) return 0;
  const aspect = box.w / Math.max(1, box.h);
  const portrait = aspect >= 0.48 && aspect <= 0.88;
  const landscape = aspect >= 1.12 && aspect <= 2.15;
  if (!portrait && !landscape) return 0;
  let score = box.score;
  if (box.label === "card" || CARD_CLASSES.has(box.classId)) score += 0.28;
  else score += 0.1;
  if (portrait) score += 0.08;
  score += Math.min(0.2, area * 0.35);
  return score;
}

export function cardFitnessSheet(box: YoloBox, W: number, H: number, cardOnly = false) {
  if (!cardOnly && box.classId === PERSON && box.label !== "card") return 0;
  const area = (box.w * box.h) / (W * H);
  if (cardOnly && area < 0.12) return 0;
  // A scan may consist entirely of one card; retain conservative COCO filtering.
  if (area < 0.006 || area > (cardOnly ? 1 : 0.95)) return 0;
  const aspect = box.w / Math.max(1, box.h);
  const portrait = aspect >= 0.48 && aspect <= 0.92;
  const landscape = aspect >= 1.08 && aspect <= 2.2;
  if (!portrait && !landscape) return 0;
  let score = box.score;
  if (cardOnly || box.label === "card" || CARD_CLASSES.has(box.classId)) score += 0.28;
  else score += 0.08;
  if (portrait) score += 0.08;
  score += Math.min(0.18, area * 0.4);
  return score;
}

function cropBox(src: ImageData, box: YoloBox): ImageData {
  const padX = Math.round(box.w * 0.08);
  const padY = Math.round(box.h * 0.08);
  const x0 = Math.max(0, Math.floor(box.x - padX));
  const y0 = Math.max(0, Math.floor(box.y - padY));
  const x1 = Math.min(src.width, Math.ceil(box.x + box.w + padX));
  const y1 = Math.min(src.height, Math.ceil(box.y + box.h + padY));
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw < 48 || ch < 48) return src;
  const out = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    const srcOff = ((y0 + y) * src.width + x0) * 4;
    out.data.set(src.data.subarray(srcOff, srcOff + cw * 4), y * cw * 4);
  }
  return out;
}

async function runDetect(
  loaded: { session: OrtSession; kind: "yolo26" | "yolo" | "card" },
  src: ImageData,
) {
  const { tensor, geometry } = letterbox(src);
  const ort = await getOrt();
  const input = new ort.Tensor("float32", tensor, [1, 3, INPUT, INPUT]);
  const feeds: Record<string, unknown> = {};
  feeds[loaded.session.inputNames[0] ?? "images"] = input;
  const result = await withTimeout(loaded.session.run(feeds), 8000, "YOLO infer timed out");
  const outName = loaded.session.outputNames[0] ?? Object.keys(result)[0];
  const output = outName ? result[outName] : undefined;
  if (!output) return [] as YoloBox[];
  // Decode in model pixels, then remove centered padding before clipping.
  const boxes = decodeYoloOutput(
    { data: output.data as Float32Array, dims: output.dims },
    1,
    INPUT,
    INPUT,
    loaded.kind === "card",
  );
  return boxes.flatMap(box => {
    const mapped = unletterboxBox(box, geometry, src.width, src.height);
    return mapped && mapped.w >= 8 && mapped.h >= 8 ? [{ ...box, ...mapped }] : [];
  });
}

export async function detectCardBoxes(src: ImageData): Promise<{
  boxes: YoloBox[];
  engine: "yolo26" | "yolo" | "card" | null;
}> {
  if (typeof window === "undefined" || yoloDisabled) {
    return { boxes: [], engine: null };
  }
  try {
    const loaded = await getSession();
    if (!loaded) return { boxes: [], engine: null };
    const raw = await runDetect(loaded, src);
    const cardOnly = loaded.kind === "card";
    const scored: Array<YoloBox & { fit: number }> = [];
    for (const box of raw) {
      const fit = cardFitnessSheet(box, src.width, src.height, cardOnly);
      if (fit > 0.22) scored.push({ ...box, score: box.score, fit });
    }
    scored.sort((a, b) => b.fit - a.fit);
    let kept = nms(scored, 32);
    let engine: "yolo26" | "yolo" | "card" | null = loaded.kind;
    if (!kept.length && loaded.kind === "card") {
      const coco = await getCocoSession();
      if (coco) {
        const raw2 = await runDetect(coco, src);
        const scored2: Array<YoloBox & { fit: number }> = [];
        for (const box of raw2) {
          const fit = cardFitnessSheet(box, src.width, src.height, false);
          if (fit > 0.22) scored2.push({ ...box, score: box.score, fit });
        }
        scored2.sort((a, b) => b.fit - a.fit);
        kept = nms(scored2, 32);
        engine = coco.kind;
      }
    }
    return { boxes: kept, engine };
  } catch {
    return { boxes: [], engine: null };
  }
}

export async function yoloCropCard(src: ImageData): Promise<YoloCrop> {
  const { boxes, engine } = await detectCardBoxes(src);
  let best: YoloBox | null = null;
  let bestFit = 0.32;
  const cardOnly = engine === "card";
  for (const box of boxes) {
    const fit = cardOnly
      ? cardFitnessSheet(box, src.width, src.height, true)
      : cardFitness(box, src.width, src.height);
    if (fit > bestFit) {
      bestFit = fit;
      best = box;
    }
  }
  if (!best) return { image: src, cropped: false, box: null, engine };
  const image = cropBox(src, best);
  const cropped = image.width !== src.width || image.height !== src.height;
  return { image, cropped, box: best, engine };
}
