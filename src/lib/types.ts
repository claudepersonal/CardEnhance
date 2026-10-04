import type { OcrEvidence } from "./ocr-quality";

export type OutputFormat = "png" | "jpg" | "webp";

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type CardSide = "front" | "back" | "unknown";

export type CropEngine = "yolo26" | "yolo" | "card" | "contour" | null;

export type OcrEngine = "vision" | "ocr" | "filename" | "paddleocr" | "paddleocr-vl";

export type CardIdentity = {
  player: string | null;
  year: number | null;
  manufacturer: string | null;
  set: string | null;
  number: string | null;
  parallel: string | null;
  side: CardSide;
  confidence: number;
  rawText: string;
  engine?: OcrEngine;
  /** Measured OCR evidence, separate from legacy identity completeness. */
  ocr?: OcrEvidence;
  filenameHints?: Partial<Pick<CardIdentity, "player" | "year" | "manufacturer" | "set" | "number" | "parallel" | "side">>;
};

export type EnhancementSettings = {
  blemishRemoval: boolean;
  blemishSensitivity: number;
  descratch: boolean;
  sharpening: boolean;
  sharpeningAmount: number;
  colorCorrection: boolean;
  colorTemperature: number;
  saturation: number;
  contrastEnhancement: boolean;
  contrastAmount: number;
  noiseReduction: boolean;
  noiseReductionStrength: number;
  upscaling: boolean;
  upscaleFactor: 1 | 2 | 4;
  preserveHolographic: boolean;
  autoCrop: boolean;
  identifyCards: boolean;
  visionOcr: boolean;
  cnnRestore: boolean;
  concurrency: 1 | 2 | 3 | 4;
  outputFormat: OutputFormat;
  outputQuality: number;
};

export const defaultSettings: EnhancementSettings = {
  blemishRemoval: true,
  blemishSensitivity: 0.7,
  descratch: true,
  sharpening: true,
  sharpeningAmount: 0.5,
  colorCorrection: true,
  colorTemperature: 0,
  saturation: 1,
  contrastEnhancement: true,
  contrastAmount: 0.3,
  noiseReduction: true,
  noiseReductionStrength: 0.45,
  upscaling: false,
  upscaleFactor: 2,
  preserveHolographic: true,
  autoCrop: true,
  identifyCards: true,
  visionOcr: true,
  cnnRestore: true,
  concurrency: 3,
  outputFormat: "jpg",
  outputQuality: 92,
};

export type CardImage = {
  id: string;
  name: string;
  originalUrl: string;
  enhancedUrl?: string;
  blemishCount: number;
  width: number;
  height: number;
  cropped: boolean;
  cropEngine?: CropEngine;
  cnn?: boolean;
  identity?: CardIdentity;
  status: JobStatus;
  error?: string;
};

export type ProcessingJob = {
  id: string;
  createdAt: number;
  status: JobStatus;
  progress: number;
  settings: EnhancementSettings;
  images: CardImage[];
  error?: string;
};
