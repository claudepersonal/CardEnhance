/** Formula Genius review rule, implemented without treating scores as probabilities. */
export type ReviewStatus = 'READY' | 'REVIEW' | 'MISSING' | 'INVALID';
export type OcrLine = {
  text: string;
  confidence: number | null;
  box?: { x: number; y: number; w: number; h: number };
};
export type OcrPass = {
  variant: string;
  rotation: 0 | 180;
  text: string;
  confidence: number | null;
  lines: OcrLine[];
};
export type OcrEvidence = {
  confidence: number | null;
  threshold: number;
  status: ReviewStatus;
  reasons: string[];
  selectedVariant: string | null;
  passes: OcrPass[];
};

export function confidenceStatus(value: unknown, threshold = 80): ReviewStatus {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new RangeError('OCR threshold must be between 0 and 100');
  }
  if (value == null || value === '') return 'MISSING';
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return 'INVALID';
  return value < threshold ? 'REVIEW' : 'READY';
}

export function aggregateConfidence(lines: Pick<OcrLine, 'text' | 'confidence'>[]): number | null {
  let sum = 0, weight = 0;
  for (const line of lines) {
    const count = line.text.replace(/\s/g, '').length;
    if (!count) continue;
    if (confidenceStatus(line.confidence) === 'MISSING' || confidenceStatus(line.confidence) === 'INVALID') return null;
    sum += line.confidence! * count;
    weight += count;
  }
  return weight ? sum / weight : null;
}

export function assessOcr(confidence: unknown, rawText: string, missingFields: string[], threshold = 80): Pick<OcrEvidence, 'status' | 'reasons' | 'threshold' | 'confidence'> {
  let status = confidenceStatus(confidence, threshold);
  const reasons: string[] = [];
  if (!rawText.trim()) {
    status = 'MISSING';
    reasons.push('No printed text was read');
  } else if (status === 'MISSING') reasons.push('OCR confidence was not measured');
  else if (status === 'INVALID') reasons.push('OCR engine returned an invalid score');
  else if (status === 'REVIEW') reasons.push(`OCR score is below ${threshold}`);
  if (missingFields.length) {
    reasons.push(`Missing printed fields: ${missingFields.join(', ')}`);
    if (status === 'READY') status = 'REVIEW';
  }
  return { status, reasons, threshold, confidence: typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 100 ? confidence : null };
}

export function selectOcrPass(passes: OcrPass[], printedFieldScore: (text: string) => number): OcrPass | null {
  let best: OcrPass | null = null;
  let rank = -Infinity;
  for (const pass of passes) {
    if (!pass.text.trim()) continue;
    // Coverage helps select a pass; it never changes the recorded OCR score.
    const next = (pass.confidence ?? 0) + printedFieldScore(pass.text) * 2;
    if (next > rank) { rank = next; best = pass; }
  }
  return best;
}

export function recognitionSize(width: number, height: number, targetHeight = 48, maxWidth = 320) {
  if (![width,height,targetHeight,maxWidth].every(v => Number.isFinite(v) && v > 0)) throw new RangeError('Invalid recognition dimensions');
  const scale = Math.min(targetHeight / height, maxWidth / width);
  const w = Math.max(1, Math.round(width * scale));
  return { width: w, height: Math.max(1, Math.round(height * scale)), paddedWidth: Math.min(maxWidth, Math.max(8, Math.ceil(w / 8) * 8)) };
}

export function boundingBoxStatus(row: {left:number;top:number;width:number;height:number;bbox:string}): "OK" | "CHECK" {
  const {left,top,width,height,bbox} = row;
  if (![left,top,width,height].every(v => Number.isInteger(v) && v >= 0) || width === 0 || height === 0) return "CHECK";
  const match = /^\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(bbox);
  if (!match) return "CHECK";
  const expected = [left,top,left+width,top+height];
  return expected.every((v,i) => v === Number(match[i+1])) ? "OK" : "CHECK";
}
