import { chromium } from "playwright";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const out = "docs/evidence/runtime";
mkdirSync(out, { recursive: true });
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const source = readFileSync("src/lib/yolo.ts", "utf8");
const confidence = Number(source.match(/const CONF = ([\d.]+);/)[1]);
const report = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  confidence,
  matching_iou: 0.5,
  model_sha256: hash("public/models/card-det.onnx"),
  source_sha256: hash("src/lib/yolo.ts"),
  dataset: "data/card-det/images/val",
  label_provenance: "heuristic labels; NOT independent ground truth",
  scope:
    "application card detector with COCO fallback disabled; actual Canvas preprocessing, decoding, fitness filters and NMS",
  optimal_f1: { status: "NOT_MEASURED" },
  independent_benchmark: {
    status: "BLOCKED",
    reason: "independently verified disjoint labels unavailable",
  },
  samples: [],
};
function iou(a, b) {
  const intersect =
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return intersect / (a.w * a.h + b.w * b.h - intersect || 1);
}
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route("**/models/yolo26n.onnx", (r) => r.abort());
  await page.route("**/models/yolov8n.onnx", (r) => r.abort());
  await page.goto("http://127.0.0.1:8080/__app-env");
  for (const file of readdirSync(report.dataset)
    .filter((x) => x.endsWith(".jpg"))
    .sort()) {
    const path = `${report.dataset}/${file}`;
    const labelPath = `data/card-det/labels/val/${file.replace(/\.jpg$/, ".txt")}`;
    const result = await page.evaluate(async (base64) => {
      const { detectCardBoxes } = await import("/src/lib/yolo.ts");
      const img = new Image();
      img.src = `data:image/jpeg;base64,${base64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return {
        width: img.width,
        height: img.height,
        ...(await detectCardBoxes(ctx.getImageData(0, 0, img.width, img.height))),
      };
    }, readFileSync(path).toString("base64"));
    if (result.engine !== "card")
      throw new Error(`Card inference not confirmed for ${file}: ${result.engine}`);
    const truth = readFileSync(labelPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const v = line.trim().split(/\s+/).map(Number);
        if (v[0] !== 0) throw new Error("Unexpected label class");
        if (v.length === 5)
          return {
            x: (v[1] - v[3] / 2) * result.width,
            y: (v[2] - v[4] / 2) * result.height,
            w: v[3] * result.width,
            h: v[4] * result.height,
          };
        if (v.length < 7 || v.length % 2 !== 1) throw new Error("Invalid polygon label");
        const xs = v.slice(1).filter((_, i) => i % 2 === 0),
          ys = v.slice(1).filter((_, i) => i % 2 === 1);
        return {
          x: Math.min(...xs) * result.width,
          y: Math.min(...ys) * result.height,
          w: (Math.max(...xs) - Math.min(...xs)) * result.width,
          h: (Math.max(...ys) - Math.min(...ys)) * result.height,
        };
      });
    const used = new Set();
    let tp = 0;
    for (const box of [...result.boxes].sort((a, b) => b.score - a.score)) {
      let best = -1,
        overlap = 0;
      truth.forEach((t, i) => {
        const score = iou(box, t);
        if (!used.has(i) && score > overlap) {
          best = i;
          overlap = score;
        }
      });
      if (best >= 0 && overlap >= report.matching_iou) {
        used.add(best);
        tp++;
      }
    }
    report.samples.push({
      file,
      image_sha256: hash(path),
      label_sha256: hash(labelPath),
      ...result,
      tp,
      fp: result.boxes.length - tp,
      fn: truth.length - tp,
    });
  }
  const totals = report.samples.reduce(
    (a, s) => ({ tp: a.tp + s.tp, fp: a.fp + s.fp, fn: a.fn + s.fn }),
    { tp: 0, fp: 0, fn: 0 },
  );
  report.fixed_threshold = {
    ...totals,
    precision: totals.tp + totals.fp ? totals.tp / (totals.tp + totals.fp) : null,
    recall: totals.tp + totals.fn ? totals.tp / (totals.tp + totals.fn) : null,
  };
  report.status = "MEASURED_AGAINST_HEURISTIC_LABELS";
} catch (error) {
  report.status = "FAILED";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  writeFileSync(`${out}/yolo-fixed-threshold.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
