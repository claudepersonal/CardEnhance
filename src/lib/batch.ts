import { create } from "zustand";
import JSZip from "jszip";
import { expandFiles } from "./pipeline";
import { validateUploadedImage } from "./validate";
import { detectCards, rectifyCard, type CardDetection } from "./detect-sheet";
import { identifyCard, identityLabel, missingPrintedFields } from "./identify";
import { saveProcessedCard } from "./connectors/persist";
import { notifyCardProcessed } from "./connectors/notify";
import { putR2Object } from "./connectors/r2";
import { upscaleCard } from "./upscale";
import { buildScratchMask, descratchCard, validateScratchMask, type DescratchLevel } from "./descratch";
import {
  artifactOfType,
  createDerivedArtifact,
  getArtifact,
  getArtifactUrl,
  storeArtifact,
  type ArtifactType,
} from "./artifacts";
import {
  imageDataFromBlob,
  rotateImage,
  sha256Hex,
  identityFilename,
  encodeImage,
  thumbnail,
} from "./image-ops";
import type { CardIdentity } from "./types";
import { assessOcr } from "./ocr-quality";
import { identityQuery, lookupCardPrices, type PriceQuote } from "./prices";

export type Stage =
  | "queued"
  | "uploading"
  | "validating"
  | "detecting"
  | "cropping"
  | "orienting"
  | "upscaling"
  | "descratching"
  | "generating_previews"
  | "completed"
  | "failed"
  | "retrying";

export type BatchStatus =
  | "queued"
  | "uploading"
  | "validating"
  | "detecting"
  | "cropping"
  | "orienting"
  | "upscaling"
  | "descratching"
  | "generating_previews"
  | "completed"
  | "partial_success"
  | "failed"
  | "cancelled"
  | "retrying";

export type DropPhase = "idle" | "drag_over" | "uploading" | "processing" | "success" | "partial_failure" | "failure";

export type SourceRecord = {
  id: string;
  filename: string;
  hash: string;
  sourceIndex: number;
  width: number;
  height: number;
  originalArtifactId: string;
  status: Stage;
  error?: string;
};

export type CardRecord = {
  id: string;
  sourceId: string;
  sourceFilename: string;
  sourceIndex: number;
  cardIndex: number;
  stage: Stage;
  selected: boolean;
  orientation: 0 | 90 | 180 | 270;
  orientationMethod: string;
  orientationConfidence: number;
  detectorMethod: string;
  detectorConfidence: number;
  geometryConfidence: number;
  geometryMethod?: string;
  identity?: CardIdentity;
  prices?: PriceQuote | null;
  priceStatus?: "idle" | "loading" | "ok" | "empty" | "error";
  priceError?: string;
  warnings: string[];
  error?: string;
  thumbUrl: string;
  croppedId: string | null;
  upscaledId: string | null;
  descratchedId: string | null;
  combinedId: string | null;
  originalId: string;
  usedRealSr?: boolean;
  maskCoverage?: number;
};

type Settings = {
  concurrency: 1 | 2 | 3 | 4;
  upscaleScale: 2 | 4;
  descratchLevel: DescratchLevel;
  exportFormat: "png" | "jpg" | "webp";
  exportQuality: number;
  reviewThreshold: number;
};

const defaultSettings: Settings = {
  concurrency: 2,
  upscaleScale: 2,
  descratchLevel: "medium",
  exportFormat: "png",
  exportQuality: 92,
  reviewThreshold: 80,
};

const pixels = new Map<string, ImageData>();

type Store = {
  settings: Settings;
  setSettings: (partial: Partial<Settings>) => void;
  dropPhase: DropPhase;
  setDropPhase: (p: DropPhase) => void;
  batchId: string;
  batchStatus: BatchStatus;
  createdAt: number;
  updatedAt: number;
  sources: SourceRecord[];
  cards: CardRecord[];
  selectedCardId: string | null;
  compareLeft: ArtifactType;
  compareRight: ArtifactType;
  setCompare: (left: ArtifactType, right: ArtifactType) => void;
  selectCard: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  selectAll: (on: boolean) => void;
  selectByStage: (stage: "completed" | "failed") => void;
  addFiles: (files: File[]) => Promise<void>;
  rotateCard: (id: string, degrees: 0 | 90 | 180 | 270) => Promise<void>;
  processUpscale: (ids: string[]) => Promise<void>;
  processDescratch: (ids: string[]) => Promise<void>;
  processCombined: (ids: string[]) => Promise<void>;
  retryCards: (ids: string[]) => Promise<void>;
  resetRectified: (id: string) => Promise<void>;
  fetchPrices: (ids: string[]) => Promise<void>;
  exportCards: (ids: string[], type: ArtifactType) => Promise<void>;
  removeSource: (id: string) => void;
  retrySource: (id: string) => Promise<void>;
  exportStatus: "idle" | "building" | "ready" | "failed";
  exportError?: string;
  cancel: () => void;
  ingestTotal: number;
  ingestDone: number;
  activeLabel: string;
  runStartedAt: number | null;
};

let cancelled = false;
let sourceCursor = 0;

function nowBatchStatus(cards: CardRecord[], sources: SourceRecord[]): BatchStatus {
  if (cancelled) return "cancelled";
  const failedCards = cards.filter((c) => c.stage === "failed").length;
  const done = cards.filter((c) => c.stage === "completed").length;
  const busyCards = cards.some((c) => !["completed", "failed", "queued"].includes(c.stage));
  const busySources = sources.some((s) =>
    ["uploading", "validating", "detecting", "cropping", "orienting"].includes(s.status),
  );
  if (busyCards || busySources) return "detecting";
  if (failedCards && done) return "partial_success";
  if (failedCards && !done) return "failed";
  if (done) return "completed";
  if (sources.some((s) => s.status === "failed") && !cards.length) return "failed";
  return "queued";
}

function dropFromBatch(status: BatchStatus): DropPhase {
  if (status === "completed") return "success";
  if (status === "partial_success") return "partial_failure";
  if (status === "failed") return "failure";
  if (status === "queued") return "idle";
  return "processing";
}

export function busyStatus(status: BatchStatus) {
  return !["queued", "completed", "partial_success", "failed", "cancelled"].includes(status);
}

export function sourceProgress(source: SourceRecord): number {
  if (source.status === "failed" || source.status === "completed") return 100;
  if (source.status === "uploading") return 8;
  if (source.status === "validating") return 18;
  if (source.status === "detecting") return 40;
  if (source.status === "cropping") return 70;
  if (source.status === "orienting") return 85;
  if (source.status === "retrying") return 20;
  return 0;
}

export function cardProgress(card: CardRecord): number {
  if (card.stage === "failed") return 100;
  if (card.stage === "queued") return 0;
  if (card.stage === "uploading") return 8;
  if (card.stage === "validating") return 16;
  if (card.stage === "retrying") return 12;
  if (card.stage === "detecting") return 35;
  if (card.stage === "cropping") return 55;
  if (card.stage === "orienting") return 70;
  if (card.stage === "upscaling") return 82;
  if (card.stage === "descratching") return 90;
  if (card.stage === "generating_previews") return 95;
  if (card.stage === "completed") {
    if (card.combinedId) return 100;
    if (card.upscaledId && card.descratchedId) return 100;
    if (card.upscaledId) return 88;
    if (card.descratchedId) return 92;
    return 76;
  }
  return 0;
}

export function computeBatchProgress(input: {
  sources: SourceRecord[];
  cards: CardRecord[];
  ingestTotal: number;
  ingestDone: number;
  batchStatus: BatchStatus;
}) {
  const { sources, cards, ingestTotal, ingestDone, batchStatus } = input;
  const ingestTarget = Math.max(ingestTotal, sources.length);
  const sourceDone = sources.filter((s) => s.status === "completed" || s.status === "failed").length;
  const cardsDone = cards.filter((c) => c.stage === "completed" || c.stage === "failed").length;
  const restoring = cards.some((c) => ["upscaling", "descratching", "generating_previews", "retrying"].includes(c.stage));
  let percent = 0;
  if (ingestTarget > 0 && sourceDone < ingestTarget) {
    const accounted = sources.reduce((sum, source) => sum + sourceProgress(source), 0);
    percent = Math.round(accounted / ingestTarget);
  } else if (restoring && cards.length) {
    percent = Math.round(cards.reduce((sum, card) => sum + cardProgress(card), 0) / cards.length);
  } else if (cards.length) {
    percent = Math.round((cardsDone / cards.length) * 100);
  } else if (sources.length) {
    percent = Math.round((sourceDone / sources.length) * 100);
  }
  const busy = busyStatus(batchStatus) || restoring || (ingestTarget > 0 && sourceDone < ingestTarget);
  const label = batchStatus.replaceAll("_", " ");
  return { percent: Math.min(100, Math.max(0, percent)), label, busy };
}

function emptyIdentity(): CardIdentity {
  return {
    player: null,
    year: null,
    manufacturer: null,
    set: null,
    number: null,
    parallel: null,
    side: "unknown",
    confidence: 0,
    rawText: "",
    engine: "ocr",
  };
}

export const useBatch = create<Store>((set, get) => ({
  settings: defaultSettings,
  setSettings: (partial) => {
    const settings = { ...get().settings, ...partial };
    if (!Number.isFinite(settings.reviewThreshold) || settings.reviewThreshold < 0 || settings.reviewThreshold > 100) return;
    set({ settings, updatedAt: Date.now(), cards: get().cards.map(card => {
      const identity = card.identity;
      if (!identity?.ocr) return card;
      const missing = missingPrintedFields(identity);
      return { ...card, identity: { ...identity, ocr: { ...identity.ocr,
        ...assessOcr(identity.ocr.confidence, identity.rawText, missing, settings.reviewThreshold) } } };
    }) });
  },
  dropPhase: "idle",
  setDropPhase: (p) => set({ dropPhase: p }),
  batchId: crypto.randomUUID(),
  batchStatus: "queued",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  sources: [],
  cards: [],
  selectedCardId: null,
  compareLeft: "cropped",
  compareRight: "upscaled",
  setCompare: (left, right) => set({ compareLeft: left, compareRight: right }),
  selectCard: (id) => set({ selectedCardId: id }),
  toggleSelect: (id) =>
    set({ cards: get().cards.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)) }),
  selectAll: (on) => set({ cards: get().cards.map((c) => ({ ...c, selected: on })) }),
  selectByStage: (stage) =>
    set({ cards: get().cards.map((c) => ({ ...c, selected: c.stage === stage })) }),
  ingestTotal: 0,
  ingestDone: 0,
  activeLabel: "",
  runStartedAt: null,
  cancel: () => {
    cancelled = true;
    set({ batchStatus: "cancelled", dropPhase: get().sources.length ? "partial_failure" : "idle", activeLabel: "Cancelled" });
  },
  addFiles: async (files) => {
    cancelled = false;
    set({
      dropPhase: "uploading",
      batchStatus: "uploading",
      activeLabel: "Reading files",
      runStartedAt: Date.now(),
    });
    let expanded: File[] = [];
    try {
      expanded = await expandFiles(files);
    } catch {
      set({ dropPhase: "failure", batchStatus: "failed", activeLabel: "Could not read files" });
      return;
    }
    const already = get().sources.length;
    set({
      dropPhase: "processing",
      batchStatus: "validating",
      ingestTotal: already + expanded.length,
      ingestDone: already,
      activeLabel: `${expanded.length} file${expanded.length === 1 ? "" : "s"}`,
    });
    const conc = get().settings.concurrency;
    let i = 0;
    const run = async () => {
      while (i < expanded.length && !cancelled) {
        const idx = i++;
        const file = expanded[idx];
        set({ activeLabel: file.name, updatedAt: Date.now() });
        await ingestSource(file, get, set);
        set({ ingestDone: get().ingestDone + 1, updatedAt: Date.now() });
      }
    };
    await Promise.all(Array.from({ length: conc }, run));
    const st = nowBatchStatus(get().cards, get().sources);
    set({ batchStatus: st, dropPhase: dropFromBatch(st), updatedAt: Date.now(), activeLabel: st === "completed" ? "" : get().activeLabel, runStartedAt: busyStatus(st) ? get().runStartedAt : null });
  },
  rotateCard: async (id, degrees) => {
    const card = get().cards.find((c) => c.id === id);
    if (!card?.croppedId) return;
    const img = pixels.get(card.croppedId);
    if (!img) return;
    const target = degrees;
    const delta = ((target - card.orientation + 360) % 360) as 0 | 90 | 180 | 270;
    if (delta === 0) return;
    const rot = rotateImage(img, delta);
    const art = await createDerivedArtifact({
      cardId: card.id,
      sourceId: card.sourceId,
      artifactType: "cropped",
      parentArtifact: card.croppedId,
      image: rot,
    });
    pixels.set(art.id, rot);
    const thumb = URL.createObjectURL(await encodeImage(thumbnail(rot), "jpg", 0.8));
    set({
      cards: get().cards.map((c) =>
        c.id === id
          ? {
              ...c,
              croppedId: art.id,
              orientation: target,
              orientationMethod: "manual",
              orientationConfidence: 1,
              thumbUrl: thumb,
              upscaledId: null,
              descratchedId: null,
              combinedId: null,
            }
          : c,
      ),
      updatedAt: Date.now(),
    });
  },
  processUpscale: async (ids) => runOnCards(ids, "upscaling", upscaleOne, get, set),
  processDescratch: async (ids) => runOnCards(ids, "descratching", descratchOne, get, set),
  processCombined: async (ids) => runOnCards(ids, "upscaling", combinedOne, get, set),
  retryCards: async (ids) => {
    const failed = get().cards.filter((c) => ids.includes(c.id) && c.stage === "failed");
    if (!failed.length) return;
    set({
      batchStatus: "retrying",
      cards: get().cards.map((c) =>
        ids.includes(c.id) && c.stage === "failed" ? { ...c, stage: "retrying", error: undefined } : c,
      ),
    });
    await runOnCards(
      failed.map((c) => c.id),
      "cropping",
      async (card) => {
        const srcArt = getArtifact(card.originalId);
        if (!srcArt) throw new Error("Original missing");
        const src = await imageDataFromBlob(srcArt.blob);
        await extractOne(src, card.sourceId, card.sourceFilename, card.sourceIndex, get, set, card.id);
      },
      get,
      set,
    );
  },
  resetRectified: async (id) => {
    set({
      cards: get().cards.map((c) =>
        c.id === id ? { ...c, upscaledId: null, descratchedId: null, combinedId: null } : c,
      ),
      compareLeft: "cropped",
      compareRight: "cropped",
    });
  },
  fetchPrices: async (ids) => {
    const targets = get().cards.filter((c) => ids.includes(c.id));
    await Promise.all(targets.map((card) => quoteCard(card.id, get, set)));
  },
  exportStatus: "idle",
  exportError: undefined,
  removeSource: (id) => {
    const nextCards = get().cards.filter((c) => c.sourceId !== id);
    set({
      sources: get().sources.filter((s) => s.id !== id),
      cards: nextCards,
      selectedCardId: nextCards.some((c) => c.id === get().selectedCardId)
        ? get().selectedCardId
        : nextCards[0]?.id ?? null,
      updatedAt: Date.now(),
    });
  },
  retrySource: async (id) => {
    const source = get().sources.find((s) => s.id === id);
    if (!source?.originalArtifactId) return;
    const srcArt = getArtifact(source.originalArtifactId);
    if (!srcArt) return;
    set({
      sources: get().sources.map((s) => (s.id === id ? { ...s, status: "detecting", error: undefined } : s)),
      cards: get().cards.filter((c) => c.sourceId !== id),
      batchStatus: "retrying",
    });
    try {
      const origPixels = await imageDataFromBlob(srcArt.blob);
      const detections = await detectCards(origPixels);
      if (!detections.length) throw new Error("No card detected");
      for (const det of detections) {
        if (cancelled) return;
        await emitDetectedCard({
          origPixels,
          origArtId: srcArt.id,
          sourceId: source.id,
          filename: source.filename,
          sourceIndex: source.sourceIndex,
          det,
          get,
          set,
        });
      }
      set({
        sources: get().sources.map((s) => (s.id === id ? { ...s, status: "completed" } : s)),
      });
    } catch (err) {
      set({
        sources: get().sources.map((s) =>
          s.id === id ? { ...s, status: "failed", error: err instanceof Error ? err.message : "Retry failed" } : s,
        ),
      });
    }
    const st = nowBatchStatus(get().cards, get().sources);
    set({ batchStatus: st, dropPhase: dropFromBatch(st) });
  },
  exportCards: async (ids, type) => {
    set({ exportStatus: "building", exportError: undefined });
    try {
    const cards = get().cards.filter((c) => ids.includes(c.id));
    const zip = new JSZip();
    const folder = zip.folder("images");
    const manifest: unknown[] = [];
    let n = 0;
    for (const card of cards) {
      const artId =
        type === "original"
          ? card.originalId
          : type === "upscaled"
            ? card.upscaledId
            : type === "descratched"
              ? card.descratchedId
              : type === "upscaled_descratched"
                ? card.combinedId
                : card.croppedId;
      const art = artId ? getArtifact(artId) : null;
      if (!art) continue;
      n++;
      const ext = get().settings.exportFormat;
      const name = identityFilename(
        [
          card.identity?.year,
          card.identity?.set,
          card.identity?.player,
          card.identity?.number,
          String(card.sourceIndex + 1).padStart(3, "0"),
          String(card.cardIndex + 1).padStart(2, "0"),
        ],
        type,
        ext,
      );
      let blob = art.blob;
      if (ext !== "png") {
        const img = pixels.get(art.id) ?? (await imageDataFromBlob(art.blob));
        blob = await encodeImage(img, ext, get().settings.exportQuality / 100);
      }
      folder?.file(name, blob);
      manifest.push({
        card_id: card.id,
        source_id: card.sourceId,
        source_filename: card.sourceFilename,
        source_index: card.sourceIndex,
        artifact_type: type,
        output_filename: name,
        original_width: getArtifact(card.originalId)?.width ?? null,
        original_height: getArtifact(card.originalId)?.height ?? null,
        output_width: art.width,
        output_height: art.height,
        orientation: card.orientation,
        detector_confidence: card.detectorConfidence,
        geometry_confidence: card.geometryConfidence,
        geometry_method: card.geometryMethod ?? null,
        upscale_model: art.upscaleModel ?? null,
        upscale_scale: art.upscaleScale ?? null,
        used_real_sr: art.usedRealSr ?? false,
        descratch_level: art.descratchLevel ?? get().settings.descratchLevel,
        descratch_algorithm: art.descratchAlgorithm ?? "telea-lite",
        descratch_mask_coverage: art.maskCoverage ?? card.maskCoverage ?? null,
        warnings: card.warnings,
        status: card.stage,
        ocr_query: identityQuery(card.identity),
        ocr_evidence: card.identity?.ocr ?? null,
        ocr_raw_text: card.identity?.rawText ?? "",
        filename_hints: card.identity?.filenameHints ?? null,
        price_median: card.prices?.medianUngraded ?? null,
        ebay_sold_url: card.prices?.ebaySoldUrl ?? null,
      });
    }
    zip.file("manifest.json", JSON.stringify({ generated_at: new Date().toISOString(), count: n, cards: manifest }, null, 2));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `CardEnhance_Export_${Date.now()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (!n) throw new Error("No exportable artifacts for that version");
    set({ exportStatus: "ready" });
    } catch (err) {
      set({ exportStatus: "failed", exportError: err instanceof Error ? err.message : "Export failed" });
      throw err;
    }
  },
}));

type Get = () => Store;
type Set = (partial: Partial<Store> | ((s: Store) => Partial<Store>)) => void;

async function quoteCard(id: string, get: Get, set: Set) {
  const card = get().cards.find((c) => c.id === id);
  if (!card) return;
  const query = identityQuery(card.identity);
  if (!query) {
    set({
      cards: get().cards.map((c) =>
        c.id === id ? { ...c, priceStatus: "empty", prices: null, priceError: "No OCR identity" } : c,
      ),
    });
    return;
  }
  set({
    cards: get().cards.map((c) => (c.id === id ? { ...c, priceStatus: "loading", priceError: undefined } : c)),
  });
  try {
    const quote = await lookupCardPrices({ data: { identity: card.identity ?? {} } });
    const empty = quote.listings.length === 0;
    set({
      cards: get().cards.map((c) =>
        c.id === id
          ? { ...c, prices: quote, priceStatus: empty ? "empty" : "ok", priceError: undefined }
          : c,
      ),
    });
  } catch (err) {
    set({
      cards: get().cards.map((c) =>
        c.id === id
          ? { ...c, priceStatus: "error", priceError: err instanceof Error ? err.message : "Price lookup failed" }
          : c,
      ),
    });
  }
}

async function persistCard(card: CardRecord) {
  try {
    await saveProcessedCard({
      data: {
        id: card.id,
        sourceId: card.sourceId,
        filename: card.sourceFilename,
        player: card.identity?.player ?? null,
        setName: card.identity?.set ?? null,
        manufacturer: card.identity?.manufacturer ?? null,
        year: card.identity?.year ?? null,
        number: card.identity?.number ?? null,
        parallel: card.identity?.parallel ?? null,
        side: card.identity?.side ?? null,
        engine: card.identity?.engine ?? null,
        detector: card.detectorMethod,
        status: card.stage,
      },
    });
    const name = identityLabel(card.identity ?? { player: null, year: null, manufacturer: null, set: null, number: null, parallel: null, side: "unknown", confidence: 0, rawText: "", engine: "ocr" });
    void notifyCardProcessed({
      data: {
        cardName: name || card.sourceFilename,
        detector: card.detectorMethod,
        engine: card.identity?.engine,
      },
    });
    const original = getArtifact(card.originalId);
    if (original?.blob && original.blob.size > 0 && original.blob.size <= 8_000_000) {
      const dataBase64 = await blobToBase64(original.blob);
      void putR2Object({
        data: {
          key: `originals/${card.sourceId}/${card.id}`,
          contentType: original.blob.type || "image/jpeg",
          dataBase64,
          cardId: card.id,
        },
      });
    }
  } catch {
    /* persist is optional — processing already succeeded */
  }
}

async function ingestSource(file: File, get: Get, set: Set) {
  const sourceIndex = sourceCursor++;
  const bytes = await file.arrayBuffer();
  const validated = await validateUploadedImage(bytes, file.name, file.type);
  if (!validated.ok) {
    set({
      sources: [
        ...get().sources,
        {
          id: crypto.randomUUID(),
          filename: validated.filename,
          hash: "",
          sourceIndex,
          width: 0,
          height: 0,
          originalArtifactId: "",
          status: "failed",
          error: validated.error,
        },
      ],
    });
    return;
  }
  const hash = await sha256Hex(validated.bytes);
  const sourceId = crypto.randomUUID();
  const origBlob = new Blob([validated.bytes], { type: validated.mime });
  const origPixels = await imageDataFromBlob(origBlob);
  const origArt = storeArtifact({
    id: crypto.randomUUID(),
    cardId: `source-${sourceId}`,
    sourceId,
    artifactType: "original",
    parentArtifact: null,
    width: origPixels.width,
    height: origPixels.height,
    warnings: [],
    blob: origBlob,
  });
  pixels.set(origArt.id, origPixels);
  set({
    sources: [
      ...get().sources,
      {
        id: sourceId,
        filename: validated.filename,
        hash,
        sourceIndex,
        width: origPixels.width,
        height: origPixels.height,
        originalArtifactId: origArt.id,
        status: "detecting",
      },
    ],
    batchStatus: "detecting",
  });
  try {
    const detections = await detectCards(origPixels);
    if (!detections.length) {
      set({
        sources: get().sources.map((s) =>
          s.id === sourceId ? { ...s, status: "failed", error: "No card detected" } : s,
        ),
      });
      return;
    }
    for (const det of detections) {
      if (cancelled) return;
      await emitDetectedCard({
        origPixels,
        origArtId: origArt.id,
        sourceId,
        filename: validated.filename,
        sourceIndex,
        det,
        get,
        set,
      });
    }
    set({
      sources: get().sources.map((s) => (s.id === sourceId ? { ...s, status: "completed" } : s)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Crop failed";
    set({
      sources: get().sources.map((s) => (s.id === sourceId ? { ...s, status: "failed", error: message } : s)),
    });
  }
}

async function emitDetectedCard(opts: {
  origPixels: ImageData;
  origArtId: string;
  sourceId: string;
  filename: string;
  sourceIndex: number;
  det: CardDetection;
  get: Get;
  set: Set;
}) {
  const { origPixels, origArtId, sourceId, filename, sourceIndex, det, get, set } = opts;
  const cardId = crypto.randomUUID();
  const rectified = rectifyCard(origPixels, det);
  const croppedArt = await createDerivedArtifact({
    cardId,
    sourceId,
    artifactType: "cropped",
    parentArtifact: origArtId,
    image: rectified,
  });
  pixels.set(croppedArt.id, rectified);
  let oriented = rectified;
  let croppedId = croppedArt.id;
  let orientation: 0 | 90 | 180 | 270 = 0;
  let orientationMethod = "layout";
  let identity: CardIdentity | undefined;
  try {
    const idn = await identifyCard(rectified, filename, { vision: false, reviewThreshold: get().settings.reviewThreshold });
    identity = idn.identity;
    if (idn.rotated) {
      oriented = rotateImage(rectified, 180);
      orientation = 180;
      orientationMethod = "ocr";
      const re = await createDerivedArtifact({
        cardId,
        sourceId,
        artifactType: "cropped",
        parentArtifact: croppedId,
        image: oriented,
      });
      pixels.set(re.id, oriented);
      croppedId = re.id;
    }
  } catch {
    /* keep rectified */
  }
  const thumb = URL.createObjectURL(await encodeImage(thumbnail(oriented), "jpg", 0.8));
  if (identity?.ocr) {
    identity = { ...identity, ocr: { ...identity.ocr,
      ...assessOcr(identity.ocr.confidence, identity.rawText, missingPrintedFields(identity), get().settings.reviewThreshold) } };
  }
  const card: CardRecord = {
    id: cardId,
    sourceId,
    sourceFilename: filename,
    sourceIndex,
    cardIndex: det.cardIndex,
    stage: "completed",
    selected: false,
    orientation,
    orientationMethod,
    orientationConfidence: orientation === 180 ? 0.8 : 0.55,
    detectorMethod: det.detectorMethod,
    detectorConfidence: det.confidence,
    geometryConfidence: det.geometryConfidence,
    geometryMethod: det.geometryMethod,
    identity,
    warnings: det.warnings,
    thumbUrl: thumb,
    croppedId,
    upscaledId: null,
    descratchedId: null,
    combinedId: null,
    originalId: origArtId,
  };
  set({
    cards: [...get().cards, card],
    selectedCardId: get().selectedCardId ?? cardId,
  });
  void persistCard(card);
  void quoteCard(card.id, get, set);
}

async function extractOne(
  src: ImageData,
  sourceId: string,
  filename: string,
  sourceIndex: number,
  get: Get,
  set: Set,
  existingId?: string,
) {
  const detections = await detectCards(src);
  if (!detections.length) throw new Error("No card detected");
  const det = detections[0];
  const rectified = rectifyCard(src, det);
  const cardId = existingId ?? crypto.randomUUID();
  const croppedArt = await createDerivedArtifact({
    cardId,
    sourceId,
    artifactType: "cropped",
    parentArtifact: null,
    image: rectified,
  });
  pixels.set(croppedArt.id, rectified);
  const thumb = URL.createObjectURL(await encodeImage(thumbnail(rectified), "jpg", 0.8));
  set({
    cards: get().cards.map((c) =>
      c.id === cardId
        ? {
            ...c,
            stage: "completed",
            error: undefined,
            croppedId: croppedArt.id,
            thumbUrl: thumb,
            warnings: det.warnings,
          }
        : c,
    ),
  });
}

async function runOnCards(
  ids: string[],
  stage: Stage,
  fn: (card: CardRecord) => Promise<void>,
  get: Get,
  set: Set,
) {
  cancelled = false;
  set({
    dropPhase: "processing",
    batchStatus: stage === "upscaling" ? "upscaling" : "descratching",
    runStartedAt: Date.now(),
    activeLabel: stage.replaceAll("_", " "),
  });
  const conc = get().settings.concurrency;
  let i = 0;
  const list = ids.filter(Boolean);
  const run = async () => {
    while (i < list.length && !cancelled) {
      const id = list[i++];
      const card = get().cards.find((c) => c.id === id);
      if (!card) continue;
      set({
        cards: get().cards.map((c) => (c.id === id ? { ...c, stage, error: undefined } : c)),
        activeLabel: identityLabel(card.identity ?? emptyIdentity()) || card.sourceFilename,
        updatedAt: Date.now(),
      });
      try {
        await fn(get().cards.find((c) => c.id === id)!);
        set({
          cards: get().cards.map((c) => (c.id === id ? { ...c, stage: "completed" } : c)),
        });
      } catch (err) {
        const message = humanError(err);
        set({
          cards: get().cards.map((c) => (c.id === id ? { ...c, stage: "failed", error: message } : c)),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, run));
  const st = nowBatchStatus(get().cards, get().sources);
  set({
    batchStatus: st,
    dropPhase: dropFromBatch(st),
    updatedAt: Date.now(),
    activeLabel: busyStatus(st) ? get().activeLabel : "",
    runStartedAt: busyStatus(st) ? get().runStartedAt : null,
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read original"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function humanError(err: unknown) {
  const msg = err instanceof Error ? err.message : "Processing failed";
  if (/upscale/i.test(msg)) return "Upscale failed";
  if (/descratch|scratch/i.test(msg)) return "Descratch failed";
  if (/crop|rectif/i.test(msg)) return "Crop failed";
  if (/model/i.test(msg)) return "Model unavailable";
  if (/detect/i.test(msg)) return "No card detected";
  return msg;
}

async function upscaleOne(card: CardRecord) {
  const cropped = card.croppedId ? pixels.get(card.croppedId) : null;
  if (!cropped) throw new Error("Crop failed");
  const scale = useBatch.getState().settings.upscaleScale;
  const result = await upscaleCard(cropped, scale);
  const art = await createDerivedArtifact({
    cardId: card.id,
    sourceId: card.sourceId,
    artifactType: "upscaled",
    parentArtifact: card.croppedId,
    image: result.image,
    extra: {
      usedRealSr: result.usedRealSr,
      upscaleScale: result.scale,
      upscaleModel: result.model,
      upscaleMethod: result.method,
      warnings: result.usedRealSr ? [] : ["Interpolation fallback"],
    },
  });
  pixels.set(art.id, result.image);
  useBatch.setState((s) => ({
    cards: s.cards.map((c) =>
      c.id === card.id
        ? { ...c, upscaledId: art.id, usedRealSr: result.usedRealSr, warnings: [...c.warnings, ...(result.usedRealSr ? [] : ["Interpolation fallback"])] }
        : c,
    ),
    compareLeft: "cropped",
    compareRight: "upscaled",
  }));
}

async function descratchOne(card: CardRecord) {
  const cropped = card.croppedId ? pixels.get(card.croppedId) : null;
  if (!cropped) throw new Error("Crop failed");
  const level = useBatch.getState().settings.descratchLevel;
  if (level === "off") {
    const art = await createDerivedArtifact({
      cardId: card.id,
      sourceId: card.sourceId,
      artifactType: "descratched",
      parentArtifact: card.croppedId,
      image: cropped,
      extra: {
        descratchLevel: "off",
        descratchAlgorithm: "none",
        maskCoverage: 0,
        warnings: ["DESCRATCH_SKIPPED"],
      },
    });
    pixels.set(art.id, cropped);
    useBatch.setState((s) => ({
      cards: s.cards.map((c) =>
        c.id === card.id
          ? { ...c, descratchedId: art.id, warnings: [...c.warnings, "DESCRATCH_SKIPPED"] }
          : c,
      ),
      compareLeft: "cropped",
      compareRight: "descratched",
    }));
    return;
  }
  const mask = buildScratchMask(cropped, level);
  const valid = validateScratchMask(mask, level);
  if (!valid.ok) {
    const art = await createDerivedArtifact({
      cardId: card.id,
      sourceId: card.sourceId,
      artifactType: "descratched",
      parentArtifact: card.croppedId,
      image: cropped,
      extra: {
        descratchLevel: level,
        descratchAlgorithm: "none",
        maskCoverage: mask.coverage,
        warnings: [valid.reason, ...mask.warnings],
      },
    });
    pixels.set(art.id, cropped);
    useBatch.setState((s) => ({
      cards: s.cards.map((c) =>
        c.id === card.id
          ? { ...c, descratchedId: art.id, maskCoverage: mask.coverage, warnings: [...c.warnings, valid.reason] }
          : c,
      ),
      compareLeft: "cropped",
      compareRight: "descratched",
    }));
    return;
  }
  const restored = descratchCard(cropped, mask, level);
  const art = await createDerivedArtifact({
    cardId: card.id,
    sourceId: card.sourceId,
    artifactType: "descratched",
    parentArtifact: card.croppedId,
    image: restored,
    extra: {
      descratchLevel: level,
      descratchAlgorithm: "telea-lite",
      maskCoverage: mask.coverage,
      warnings: mask.warnings,
    },
  });
  pixels.set(art.id, restored);
  useBatch.setState((s) => ({
    cards: s.cards.map((c) =>
      c.id === card.id ? { ...c, descratchedId: art.id, maskCoverage: mask.coverage } : c,
    ),
    compareLeft: "cropped",
    compareRight: "descratched",
  }));
}

async function combinedOne(card: CardRecord) {
  await descratchOne(card);
  const latest = useBatch.getState().cards.find((c) => c.id === card.id);
  const srcId = latest?.descratchedId ?? latest?.croppedId;
  const src = srcId ? pixels.get(srcId) : null;
  if (!src) throw new Error("Descratch failed");
  const scale = useBatch.getState().settings.upscaleScale;
  const result = await upscaleCard(src, scale);
  const art = await createDerivedArtifact({
    cardId: card.id,
    sourceId: card.sourceId,
    artifactType: "upscaled_descratched",
    parentArtifact: srcId ?? null,
    image: result.image,
    extra: {
      usedRealSr: result.usedRealSr,
      upscaleScale: result.scale,
      upscaleModel: result.model,
      upscaleMethod: result.method,
      descratchLevel: useBatch.getState().settings.descratchLevel,
      descratchAlgorithm: "telea-lite",
      maskCoverage: latest?.maskCoverage,
    },
  });
  pixels.set(art.id, result.image);
  useBatch.setState((s) => ({
    cards: s.cards.map((c) =>
      c.id === card.id ? { ...c, combinedId: art.id, usedRealSr: result.usedRealSr } : c,
    ),
    compareLeft: "cropped",
    compareRight: "upscaled_descratched",
  }));
}

export function cardUrl(card: CardRecord, type: ArtifactType): string | null {
  const id =
    type === "original"
      ? card.originalId
      : type === "upscaled"
        ? card.upscaledId
        : type === "descratched"
          ? card.descratchedId
          : type === "upscaled_descratched"
            ? card.combinedId
            : card.croppedId;
  return getArtifactUrl(id);
}

export function downloadArtifact(card: CardRecord, type: ArtifactType) {
  const url = cardUrl(card, type);
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = identityFilename(
    [card.identity?.player ?? card.sourceFilename, card.cardIndex + 1],
    type,
    "png",
  );
  a.click();
}

export { identityLabel, getArtifact, artifactOfType };
export type { ArtifactType };
