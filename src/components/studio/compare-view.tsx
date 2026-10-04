import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useStudio } from "@/lib/jobs";
import { identityLabel } from "@/lib/identify";
import type { CardIdentity, CropEngine } from "@/lib/types";

export function IdentityChips({
  identity,
  cropped,
  cropEngine,
  cnn,
}: {
  identity?: CardIdentity;
  cropped: boolean;
  cropEngine?: CropEngine;
  cnn?: boolean;
}) {
  if (!identity && !cropped && !cnn) return null;
  const chips = [
    identity?.player,
    identity?.year ? String(identity.year) : null,
    identity?.manufacturer,
    identity?.set,
    identity?.parallel,
    identity?.number,
    identity?.side && identity.side !== "unknown" ? identity.side : null,
  ].filter(Boolean) as string[];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Badge key={chip} variant="outline" className="border-accent/30 text-accent">
          {chip}
        </Badge>
      ))}
      {cropped ? (
        <Badge variant="outline" className="text-muted">
          {cropEngine === "yolo26"
            ? "YOLO26 crop"
            : cropEngine === "yolo"
              ? "YOLO crop"
              : cropEngine === "contour"
                ? "Contour crop"
                : "Cropped"}
        </Badge>
      ) : null}
      {cnn ? (
        <Badge variant="outline" className="border-accent/40 text-accent">
          Real-ESRGAN
        </Badge>
      ) : null}
      {identity?.engine === "vision" ? (
        <Badge variant="outline" className="border-accent/40 text-accent">
          Vision OCR
        </Badge>
      ) : identity?.engine === "ocr" ? (
        <Badge variant="outline" className="text-muted">
          OCR
        </Badge>
      ) : null}
      {identity?.ocr?.confidence != null ? (
        <span className="font-mono text-[10px] text-muted tabular-nums">
          OCR score {Math.round(identity.ocr.confidence)} / 100
        </span>
      ) : null}
    </div>
  );
}

export function CompareView() {
  const jobs = useStudio((s) => s.jobs);
  const selectedJobId = useStudio((s) => s.selectedJobId);
  const job = jobs.find((j) => j.id === selectedJobId) ?? jobs[0];
  const [index, setIndex] = useState(0);
  const [split, setSplit] = useState(50);

  const image = job?.images[Math.min(index, (job?.images.length ?? 1) - 1)];

  const stats = useMemo(() => {
    if (!image) return null;
    return {
      blemish: image.blemishCount,
      size: image.width && image.height ? `${image.width}×${image.height}` : "—",
    };
  }, [image]);

  if (!job || !image) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted">
        Select a job to compare before and after.
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-auto px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-2xl tracking-tight text-fg">Preview</h2>
          <p className="mt-1 truncate text-sm text-muted">
            {image.identity ? identityLabel(image.identity) : image.name}
          </p>
        </div>
        <div className="flex gap-4 font-mono text-xs text-muted tabular-nums">
          <span>{stats?.size}</span>
          <span>{stats?.blemish} blemish px</span>
        </div>
      </div>

      <IdentityChips identity={image.identity} cropped={image.cropped} cropEngine={image.cropEngine} cnn={image.cnn} />

      {job.images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {job.images.map((img, i) => (
            <button
              key={img.id}
              type="button"
              onClick={() => {
                setIndex(i);
                setSplit(50);
              }}
              className={`h-16 w-12 shrink-0 overflow-hidden rounded-lg border ${
                i === index ? "border-accent" : "border-border"
              }`}
              title={img.identity?.player ?? img.name}
            >
              <img src={img.originalUrl} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <div
        className="relative mx-auto w-full max-w-md touch-none overflow-hidden rounded-2xl border border-border bg-elevated"
        style={{
          aspectRatio:
            image.width && image.height ? `${image.width} / ${image.height}` : "2 / 3",
        }}
        onPointerDown={(e) => {
          const target = e.currentTarget;
          const move = (clientX: number) => {
            const rect = target.getBoundingClientRect();
            const x = ((clientX - rect.left) / rect.width) * 100;
            setSplit(Math.min(100, Math.max(0, x)));
          };
          target.setPointerCapture(e.pointerId);
          move(e.clientX);
          const onMove = (ev: PointerEvent) => move(ev.clientX);
          const onUp = () => {
            target.removeEventListener("pointermove", onMove);
            target.removeEventListener("pointerup", onUp);
          };
          target.addEventListener("pointermove", onMove);
          target.addEventListener("pointerup", onUp);
        }}
      >
        <img
          src={image.originalUrl}
          alt="Original scan"
          className="absolute inset-0 size-full object-contain"
        />
        {image.enhancedUrl ? (
          <img
            src={image.enhancedUrl}
            alt="Enhanced"
            className="absolute inset-0 size-full object-contain"
            style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/40 text-sm text-muted">
            {image.status === "failed" ? image.error : "Still processing"}
          </div>
        )}
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
          style={{ left: `${split}%` }}
        >
          <div className="absolute top-1/2 left-1/2 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent bg-bg" />
        </div>
        <div className="pointer-events-none absolute top-3 left-3 rounded-full bg-bg/80 px-2 py-1 text-xs tracking-wider text-muted uppercase">
          Original
        </div>
        <div className="pointer-events-none absolute top-3 right-3 rounded-full bg-bg/80 px-2 py-1 text-xs tracking-wider text-accent uppercase">
          Enhanced
        </div>
      </div>
    </div>
  );
}
