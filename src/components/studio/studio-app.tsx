import { useCallback, useRef, useState } from "react";
import {
  Check,
  Download,
  Eraser,
  Loader2,
  Maximize,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";
import { FoilField } from "@/components/studio/foil-field";
import { ConnectorStatusBar } from "@/components/studio/connector-status";
import { AppNav } from "@/components/studio/app-nav";
import { PriceQuoteView } from "@/components/studio/price-quote";
import { BatchProgress, CardProgressBar, SourceProgressBar } from "@/components/studio/batch-progress";
import {
  useBatch,
  cardUrl,
  downloadArtifact,
  identityLabel,
  type ArtifactType,
  type CardRecord,
  type DropPhase,
  type SourceRecord,
} from "@/lib/batch";
import { getArtifactUrl } from "@/lib/artifacts";
import { cn } from "@/lib/utils";

const ACCEPT = "image/jpeg,image/png,image/webp,image/bmp,image/tiff,application/zip,.zip";

const LOT = [
  { src: "/samples/mesh/darby-allin-front.jpg", name: "darby-allin-front.jpg" },
  { src: "/samples/mesh/mina-shirakawa-dazzlers.jpg", name: "mina-shirakawa-dazzlers.jpg" },
  { src: "/samples/mesh/chelsea-green-table.jpg", name: "chelsea-green-table.jpg" },
  { src: "/samples/mesh/bret-hart-chrome.jpg", name: "bret-hart-chrome.jpg" },
] as const;

const VERSIONS: { key: ArtifactType; label: string; badge: string }[] = [
  { key: "original", label: "Original", badge: "ORIG" },
  { key: "cropped", label: "Rectified", badge: "RECT" },
  { key: "upscaled", label: "Upscaled", badge: "UP" },
  { key: "descratched", label: "Descratched", badge: "DS" },
  { key: "upscaled_descratched", label: "Descratch + Upscale", badge: "UP+DS" },
];

export function StudioApp() {
  const cards = useBatch((s) => s.cards);
  const sources = useBatch((s) => s.sources);
  const dropPhase = useBatch((s) => s.dropPhase);
  const batchStatus = useBatch((s) => s.batchStatus);
  const selectedCardId = useBatch((s) => s.selectedCardId);
  const selected = cards.find((c) => c.id === selectedCardId) ?? cards[0] ?? null;
  const completed = cards.filter((c) => c.stage === "completed").length;
  const failed = cards.filter((c) => c.stage === "failed").length;
  const processing = cards.filter((c) => !["completed", "failed", "queued"].includes(c.stage)).length;
  const selectedCount = cards.filter((c) => c.selected).length;

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-bg text-fg">
      <FoilField />
      <Toaster position="top-right" />
      <div className="relative z-10 flex min-h-dvh flex-col">
        <header className="border-b border-border bg-surface/80">
          <AppNav current="/" />
          <div className="mx-auto flex max-w-7xl items-center justify-end gap-2 px-4 pb-3 sm:px-6">
            <ConnectorStatusBar />
            {completed > 0 ? (
              <Badge variant="outline" className="hidden sm:inline-flex">
                {completed} ready
              </Badge>
            ) : null}
            {processing > 0 ? (
              <Badge variant="outline" className="border-accent/40 text-accent">
                {processing} running
              </Badge>
            ) : null}
            {failed > 0 ? (
              <Badge variant="outline" className="border-destructive/40 text-destructive">
                {failed} failed
              </Badge>
            ) : null}
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-3 py-4 sm:px-6">
          <DropPanel phase={dropPhase} status={batchStatus} sourceCount={sources.length} cardCount={cards.length} />
          {sources.length || cards.length ? <BatchProgress /> : null}
          {sources.length ? <SourceQueue sources={sources} /> : null}
          {cards.length > 0 ? (
            <>
              <BatchBar
                sources={sources.length}
                cards={cards.length}
                completed={completed}
                failed={failed}
                processing={processing}
                selectedCount={selectedCount}
                currentId={selected?.id ?? null}
              />
              <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
                <CardGrid cards={cards} selectedId={selected?.id ?? null} />
                {selected ? <Workspace card={selected} /> : <EmptyWorkspace />}
              </div>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function DropPanel({
  phase,
  status,
  sourceCount,
  cardCount,
}: {
  phase: DropPhase;
  status: string;
  sourceCount: number;
  cardCount: number;
}) {
  const addFiles = useBatch((s) => s.addFiles);
  const setDropPhase = useBatch((s) => s.setDropPhase);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const ingest = useCallback(
    async (list: FileList | File[] | null) => {
      if (!list || list.length === 0) return;
      try {
        await addFiles(Array.from(list));
        toast.success("Batch updated");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed");
      }
    },
    [addFiles],
  );

  const loadNamed = async (items: readonly { src: string; name: string }[]) => {
    const files = await Promise.all(
      items.map(async (s) => {
        const res = await fetch(s.src);
        return new File([await res.blob()], s.name, { type: "image/jpeg" });
      }),
    );
    await ingest(files);
  };

  const label =
    phase === "drag_over"
      ? "Drop to add"
      : phase === "uploading"
        ? "Uploading"
        : phase === "processing"
          ? "Detecting cards"
          : phase === "success"
            ? "Ready — drop more to add"
            : phase === "partial_failure"
              ? "Partial success"
              : phase === "failure"
                ? "Upload failed"
                : "Drop sports-card images or scanner sheets here";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload card images"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
        setDropPhase("drag_over");
      }}
      onDragLeave={() => {
        setOver(false);
        setDropPhase(sourceCount ? "success" : "idle");
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void ingest(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "rounded-3xl border border-dashed px-4 py-8 text-center transition-[border-color,background-color] sm:py-10",
        over || phase === "drag_over" ? "border-accent bg-accent/10" : "border-border bg-surface/70",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        onChange={(e) => {
          void ingest(e.target.files);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => {
          void ingest(e.target.files);
          e.currentTarget.value = "";
        }}
      />
      <Upload className="mx-auto size-8 text-accent" />
      <p className="mt-3 font-display text-xl tracking-tight">{label}</p>
      <p className="mt-1 text-sm text-muted">
        One image, many images, or a ZIP. Multi-card sheets split automatically.
      </p>
      <p className="mt-1 text-xs text-muted">
        {sourceCount} sources · {cardCount} cards · {status.replaceAll("_", " ")}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Button type="button" size="sm" onClick={() => inputRef.current?.click()}>
          Choose Images
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => cameraRef.current?.click()}>
          Camera
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadNamed(LOT)}>
          Load sample scans
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            const res = await fetch("/samples/scanner-dump.zip");
            const file = new File([await res.blob()], "scanner-dump.zip", { type: "application/zip" });
            await ingest([file]);
          }}
        >
          70-card dump
        </Button>
      </div>
    </div>
  );
}

function SourceQueue({ sources }: { sources: SourceRecord[] }) {
  const removeSource = useBatch((s) => s.removeSource);
  const retrySource = useBatch((s) => s.retrySource);
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {sources.map((source) => (
        <li key={source.id} className="flex gap-3 rounded-2xl border border-border bg-surface p-2">
          <img
            src={getArtifactUrl(source.originalArtifactId) ?? ""}
            alt=""
            className="size-14 rounded-lg object-cover bg-elevated"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{source.filename}</p>
            <p className="text-xs text-muted">
              {source.status.replaceAll("_", " ")}
              {source.width ? ` · ${source.width}×${source.height}` : ""}
            </p>
            <SourceProgressBar source={source} />
            {source.error ? <p className="text-xs text-destructive">{source.error}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            {source.status === "failed" && source.originalArtifactId ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void retrySource(source.id)}>
                Retry
              </Button>
            ) : null}
            <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${source.filename}`} onClick={() => removeSource(source.id)}>
              <X className="size-4" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function BatchBar({
  sources,
  cards,
  completed,
  failed,
  processing,
  selectedCount,
  currentId,
}: {
  sources: number;
  cards: number;
  completed: number;
  failed: number;
  processing: number;
  selectedCount: number;
  currentId: string | null;
}) {
  const settings = useBatch((s) => s.settings);
  const setSettings = useBatch((s) => s.setSettings);
  const selectAll = useBatch((s) => s.selectAll);
  const selectByStage = useBatch((s) => s.selectByStage);
  const processUpscale = useBatch((s) => s.processUpscale);
  const processDescratch = useBatch((s) => s.processDescratch);
  const processCombined = useBatch((s) => s.processCombined);
  const retryCards = useBatch((s) => s.retryCards);
  const allCards = useBatch((s) => s.cards);
  const ids = allCards.filter((c) => c.selected).map((c) => c.id);
  const target = ids.length ? ids : allCards.map((c) => c.id);
  const failedIds = allCards.filter((c) => c.stage === "failed").map((c) => c.id);
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="text-muted">
          <span className="text-fg tabular-nums">{sources}</span> sources ·{" "}
          <span className="text-fg tabular-nums">{cards}</span> cards ·{" "}
          <span className="text-fg tabular-nums">{processing}</span> processing ·{" "}
          <span className="text-fg tabular-nums">{completed}</span> ready ·{" "}
          <span className="text-fg tabular-nums">{failed}</span> failed ·{" "}
          <span className="text-fg tabular-nums">{selectedCount}</span> selected
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => selectAll(true)}>
            Select all
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => selectByStage("completed")}>
            Select completed
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => selectByStage("failed")}>
            Select failed
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => selectAll(false)}>
            Clear selection
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void processUpscale(target)}>
          <Maximize className="size-4" />
          Upscale {selectedCount || "all"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void processDescratch(target)}>
          <Eraser className="size-4" />
          Descratch selected
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void processCombined(target)}>
          <Sparkles className="size-4" />
          Descratch + Upscale selected
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!failedIds.length} onClick={() => void retryCards(failedIds)}>
          Retry failed
        </Button>
        <Button type="button" size="sm" className="ml-auto" onClick={() => setExportOpen(true)}>
          <Download className="size-4" />
          Export
        </Button>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted">
        <label className="flex items-center gap-2">
          Scale
          <select
            className="h-10 rounded-lg border border-border bg-elevated px-2 text-fg"
            value={settings.upscaleScale}
            onChange={(e) => setSettings({ upscaleScale: Number(e.target.value) as 2 | 4 })}
          >
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Descratch
          <select
            className="h-10 rounded-lg border border-border bg-elevated px-2 text-fg"
            value={settings.descratchLevel}
            onChange={(e) => setSettings({ descratchLevel: e.target.value as typeof settings.descratchLevel })}
          >
            <option value="off">Off</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Concurrency
          <select
            className="h-10 rounded-lg border border-border bg-elevated px-2 text-fg"
            value={settings.concurrency}
            onChange={(e) => setSettings({ concurrency: Number(e.target.value) as 1 | 2 | 3 | 4 })}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          OCR review below
          <input type="number" min={0} max={100} step={1}
            className="h-10 w-20 rounded-lg border border-border bg-elevated px-2 text-fg"
            value={settings.reviewThreshold}
            onChange={(event) => { if (event.target.value !== "") setSettings({ reviewThreshold: Number(event.target.value) }); }} />
        </label>
      </div>
      {exportOpen ? (
        <ExportDialog currentId={currentId} onClose={() => setExportOpen(false)} />
      ) : null}
    </div>
  );
}

function ExportDialog({ currentId, onClose }: { currentId: string | null; onClose: () => void }) {
  const cards = useBatch((s) => s.cards);
  const settings = useBatch((s) => s.settings);
  const setSettings = useBatch((s) => s.setSettings);
  const exportCards = useBatch((s) => s.exportCards);
  const exportStatus = useBatch((s) => s.exportStatus);
  const exportError = useBatch((s) => s.exportError);
  const [scope, setScope] = useState<"current" | "selected" | "completed">("selected");
  const [version, setVersion] = useState<ArtifactType>("cropped");
  const selected = cards.filter((c) => c.selected);
  const completed = cards.filter((c) => c.stage === "completed");
  const ids =
    scope === "current" && currentId
      ? [currentId]
      : scope === "selected"
        ? selected.length
          ? selected.map((c) => c.id)
          : completed.map((c) => c.id)
        : completed.map((c) => c.id);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-bg/70 p-4 sm:items-center" role="dialog" aria-labelledby="export-title">
      <div className="w-full max-w-lg space-y-4 rounded-2xl border border-border bg-surface p-4 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="export-title" className="font-display text-xl">
              Export
            </h2>
            <p className="text-sm text-muted">{ids.length} cards · real ZIP with images/ and manifest.json</p>
          </div>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close export">
            <X className="size-4" />
          </Button>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted uppercase">Scope</legend>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={scope === "current" ? "default" : "outline"} disabled={!currentId} onClick={() => setScope("current")}>
              Current card
            </Button>
            <Button type="button" size="sm" variant={scope === "selected" ? "default" : "outline"} onClick={() => setScope("selected")}>
              Selected ({selected.length})
            </Button>
            <Button type="button" size="sm" variant={scope === "completed" ? "default" : "outline"} onClick={() => setScope("completed")}>
              All completed ({completed.length})
            </Button>
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted uppercase">Version</legend>
          <div className="flex flex-wrap gap-2">
            {VERSIONS.map((v) => (
              <Button key={v.key} type="button" size="sm" variant={version === v.key ? "default" : "outline"} onClick={() => setVersion(v.key)}>
                {v.label}
              </Button>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-sm">
            Format
            <select
              className="h-10 rounded-lg border border-border bg-elevated px-2"
              value={settings.exportFormat}
              onChange={(e) => setSettings({ exportFormat: e.target.value as typeof settings.exportFormat })}
            >
              <option value="png">PNG</option>
              <option value="jpg">JPEG</option>
              <option value="webp">WebP</option>
            </select>
          </label>
          {settings.exportFormat !== "png" ? (
            <label className="flex items-center gap-2 text-sm">
              Quality
              <input
                type="range"
                min={60}
                max={100}
                value={settings.exportQuality}
                onChange={(e) => setSettings({ exportQuality: Number(e.target.value) })}
              />
              <span className="tabular-nums">{settings.exportQuality}</span>
            </label>
          ) : null}
        </div>
        {exportStatus === "building" ? <p className="text-sm text-muted">Building ZIP…</p> : null}
        {exportStatus === "failed" ? <p className="text-sm text-destructive">{exportError}</p> : null}
        {exportStatus === "ready" ? <p className="text-sm text-accent">Download started.</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            type="button"
            disabled={!ids.length || exportStatus === "building"}
            onClick={async () => {
              try {
                await exportCards(ids, version);
                toast.success("ZIP downloaded");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Export failed");
              }
            }}
          >
            {exportStatus === "building" ? "Exporting…" : "Download ZIP"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CardGrid({ cards, selectedId }: { cards: CardRecord[]; selectedId: string | null }) {
  const selectCard = useBatch((s) => s.selectCard);
  const toggleSelect = useBatch((s) => s.toggleSelect);
  return (
    <div className="max-h-[40vh] overflow-auto rounded-2xl border border-border bg-surface p-2 lg:max-h-none">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-2">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => selectCard(card.id)}
            className={cn(
              "relative overflow-hidden rounded-xl border text-left",
              card.id === selectedId ? "border-accent" : "border-border",
              card.stage === "failed" && "border-destructive/60",
            )}
          >
            <img src={card.thumbUrl} alt={card.identity?.player ?? card.sourceFilename} className="aspect-[2/3] w-full object-cover" />
            <span className="absolute top-1 left-1 rounded bg-bg/80 px-1 font-mono text-[10px] text-fg">
              {card.sourceIndex + 1}.{card.cardIndex + 1} · {card.orientation}°
            </span>
            <span
              role="checkbox"
              aria-checked={card.selected}
              aria-label={`Select card ${card.cardIndex + 1}`}
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                toggleSelect(card.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleSelect(card.id);
                }
              }}
              className={cn(
                "absolute top-1 right-1 flex size-6 items-center justify-center rounded border",
                card.selected ? "border-accent bg-accent text-accent-foreground" : "border-border bg-bg/70",
              )}
            >
              {card.selected ? <Check className="size-3" /> : null}
            </span>
            <span className="absolute bottom-6 left-1 flex flex-wrap gap-0.5">
              {card.croppedId ? <MiniBadge>RECT</MiniBadge> : null}
              {card.upscaledId ? <MiniBadge>UP</MiniBadge> : null}
              {card.descratchedId ? <MiniBadge>DS</MiniBadge> : null}
              {card.combinedId ? <MiniBadge>UP+DS</MiniBadge> : null}
            </span>
            <span className="block truncate bg-bg/80 px-1 py-1 text-[10px] text-muted">{stageLabel(card)}</span>
            <CardProgressBar card={card} />
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniBadge({ children }: { children: string }) {
  return <span className="rounded bg-bg/80 px-1 text-[9px] tracking-wide text-accent">{children}</span>;
}

function stageLabel(card: CardRecord) {
  if (card.stage === "failed") return card.error ?? "Failed";
  if (card.stage === "completed") return card.identity?.player ?? "Ready";
  return card.stage.replaceAll("_", " ");
}

function EmptyWorkspace() {
  return (
    <div className="flex min-h-80 items-center justify-center rounded-2xl border border-border bg-surface text-sm text-muted">
      Select a card
    </div>
  );
}

function availableVersions(card: CardRecord) {
  return VERSIONS.filter((v) => {
    if (v.key === "original") return Boolean(card.originalId);
    if (v.key === "cropped") return Boolean(card.croppedId);
    if (v.key === "upscaled") return Boolean(card.upscaledId);
    if (v.key === "descratched") return Boolean(card.descratchedId);
    return Boolean(card.combinedId);
  });
}

function Workspace({ card }: { card: CardRecord }) {
  const rotateCard = useBatch((s) => s.rotateCard);
  const processUpscale = useBatch((s) => s.processUpscale);
  const processDescratch = useBatch((s) => s.processDescratch);
  const processCombined = useBatch((s) => s.processCombined);
  const retryCards = useBatch((s) => s.retryCards);
  const resetRectified = useBatch((s) => s.resetRectified);
  const fetchPrices = useBatch((s) => s.fetchPrices);
  const toggleSelect = useBatch((s) => s.toggleSelect);
  const compareLeft = useBatch((s) => s.compareLeft);
  const compareRight = useBatch((s) => s.compareRight);
  const setCompare = useBatch((s) => s.setCompare);
  const scale = useBatch((s) => s.settings.upscaleScale);
  const versions = availableVersions(card);
  const left = versions.some((v) => v.key === compareLeft) ? compareLeft : "cropped";
  const right = versions.some((v) => v.key === compareRight) ? compareRight : versions.at(-1)?.key ?? "cropped";
  const leftUrl = cardUrl(card, left);
  const rightUrl = cardUrl(card, right);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-display text-xl tracking-tight">
            {card.identity ? identityLabel(card.identity) : card.sourceFilename}
          </h2>
          <p className="text-xs text-muted">
            {card.sourceFilename} · card {card.cardIndex + 1} · {card.orientation}° · {card.detectorMethod}{" "}
            {Math.round(card.detectorConfidence * 100)}% · {card.geometryMethod ?? "axis_box"} {Math.round(card.geometryConfidence * 100)}%
            {card.croppedId ? " · rectified" : ""}
          </p>
        </div>
        {card.stage === "failed" ? (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">{card.error}</p>
            <Button type="button" size="sm" onClick={() => void retryCards([card.id])}>
              Retry
            </Button>
          </div>
        ) : null}
      </div>
      <ComparePane leftUrl={leftUrl} rightUrl={rightUrl} left={left} right={right} />
      {card.identity?.ocr ? (
        <section aria-label="OCR review" className="border-t border-border pt-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded px-2 py-1 text-xs font-medium", card.identity.ocr.status === "READY" ? "bg-accent/10 text-accent" : "bg-elevated text-fg")}>
              {card.identity.ocr.status === "READY" ? "OCR ready" : "Review OCR"}
            </span>
            <span className="text-xs text-muted">
              {card.identity.ocr.confidence == null ? "Score unmeasured" : `OCR score ${card.identity.ocr.confidence.toFixed(1)} / 100`}
              {" · "}{card.identity.engine}{" · threshold "}{card.identity.ocr.threshold}
            </span>
          </div>
          {card.identity.ocr.reasons.length ? <p className="mt-2 text-xs text-muted">{card.identity.ocr.reasons.join(" · ")}</p> : null}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-accent">Printed text and OCR passes</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-elevated p-3 text-xs">{card.identity.rawText || "No printed text was read"}</pre>
            {card.identity.ocr.passes.map((pass, index) => (
              <div key={index} className="mt-2 border-t border-border pt-2 text-xs">
                <p>{pass.variant}{pass.variant === card.identity?.ocr?.selectedVariant ? " · selected" : ""} · {pass.rotation}° · {pass.confidence == null ? "unmeasured" : `${pass.confidence.toFixed(1)} / 100`}</p>
                {pass.lines.map((line, lineIndex) => <p key={lineIndex} className="mt-1 break-words text-muted">
                  {line.text}{line.box ? ` · box (${Math.round(line.box.x)}, ${Math.round(line.box.y)}, ${Math.round(line.box.w)}, ${Math.round(line.box.h)})` : ""}
                </p>)}
              </div>
            ))}
            {card.identity.filenameHints && Object.keys(card.identity.filenameHints).length ? <p className="mt-2 text-xs text-muted">Filename hints (not OCR): {JSON.stringify(card.identity.filenameHints)}</p> : null}
          </details>
        </section>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-xs text-muted">
          Before
          <select
            className="h-10 flex-1 rounded-lg border border-border bg-elevated px-2 text-fg"
            value={left}
            onChange={(e) => setCompare(e.target.value as ArtifactType, right)}
          >
            {versions.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          After
          <select
            className="h-10 flex-1 rounded-lg border border-border bg-elevated px-2 text-fg"
            value={right}
            onChange={(e) => setCompare(left, e.target.value as ArtifactType)}
          >
            {versions.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        {VERSIONS.filter((v) => !versions.some((a) => a.key === v.key) && v.key !== "original").map((v) => (
          <Button
            key={v.key}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (v.key === "upscaled") void processUpscale([card.id]);
              else if (v.key === "descratched") void processDescratch([card.id]);
              else void processCombined([card.id]);
            }}
          >
            Generate {v.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void rotateCard(card.id, ((card.orientation + 270) % 360) as 0 | 90 | 180 | 270)} aria-label="Rotate left">
          <RotateCcw className="size-4" />
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void rotateCard(card.id, ((card.orientation + 90) % 360) as 0 | 90 | 180 | 270)} aria-label="Rotate right">
          <RotateCw className="size-4" />
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void rotateCard(card.id, 0)}>
          0°
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void rotateCard(card.id, 90)}>
          90°
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void rotateCard(card.id, 180)}>
          180°
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void rotateCard(card.id, 270)}>
          270°
        </Button>
        <Button type="button" size="sm" onClick={() => void processUpscale([card.id])}>
          Upscale {scale}×
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void processDescratch([card.id])}>
          Descratch card
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void processCombined([card.id])}>
          Descratch + Upscale card
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void resetRectified(card.id)}>
          View rectified
        </Button>
        <Button type="button" size="sm" variant={card.selected ? "default" : "outline"} onClick={() => toggleSelect(card.id)}>
          {card.selected ? "Selected" : "Select"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => downloadArtifact(card, right)} disabled={!rightUrl}>
          <Download className="size-4" />
          Download
        </Button>
      </div>
      {card.warnings.length ? <p className="text-xs text-muted">{card.warnings.join(" · ")}</p> : null}
      {card.usedRealSr === false ? <p className="text-xs text-muted">Upscale used interpolation, not Real-ESRGAN.</p> : null}
      {card.usedRealSr ? <p className="text-xs text-accent">Real-ESRGAN super-resolution</p> : null}
      <PriceQuoteView
        quote={card.prices}
        status={card.priceStatus}
        error={card.priceError}
        onRefresh={() => void fetchPrices([card.id])}
      />
    </div>
  );
}

function ComparePane({
  leftUrl,
  rightUrl,
  left,
  right,
}: {
  leftUrl: string | null;
  rightUrl: string | null;
  left: string;
  right: string;
}) {
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [full, setFull] = useState(false);
  const a = leftUrl;
  const b = rightUrl ?? leftUrl;
  if (!a) {
    return (
      <div className="flex aspect-[2/3] max-h-[70vh] items-center justify-center rounded-xl border border-border text-sm text-muted">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Generating preview
      </div>
    );
  }
  const viewer = (
    <div
      className={cn(
        "relative touch-none overflow-hidden rounded-xl border border-border bg-elevated",
        full ? "h-[min(90dvh,900px)] w-full" : "mx-auto aspect-[2/3] w-full max-w-md",
      )}
      onPointerDown={(e) => {
        const target = e.currentTarget;
        const rect = () => target.getBoundingClientRect();
        const nearSplit = Math.abs(e.clientX - (rect().left + (rect().width * split) / 100)) < 18;
        const panMode = zoom > 1 && !nearSplit;
        const origin = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
        e.currentTarget.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          ev.preventDefault();
          const box = rect();
          if (panMode) {
            setPan({
              x: origin.panX + ev.clientX - origin.x,
              y: origin.panY + ev.clientY - origin.y,
            });
            return;
          }
          setSplit(Math.min(96, Math.max(4, ((ev.clientX - box.left) / box.width) * 100)));
        };
        move(e.nativeEvent);
        const onMove = (ev: PointerEvent) => move(ev);
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }}
    >
      <div
        className="absolute inset-0"
        style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: "center center" }}
      >
        <img src={b ?? a} alt="After" className="absolute inset-0 size-full object-contain" />
        <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          <img src={a} alt="Before" className="absolute inset-0 size-full object-contain" />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-accent" style={{ left: `${split}%` }} />
      <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-bg/80 px-2 py-0.5 text-[10px] uppercase">
        {left}
      </span>
      <span className="pointer-events-none absolute right-2 bottom-2 rounded bg-bg/80 px-2 py-0.5 text-[10px] uppercase">
        {right}
      </span>
    </div>
  );
  const controls = (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button type="button" size="icon-sm" variant="outline" onClick={() => setZoom((z) => Math.max(1, z - 0.25))} aria-label="Zoom out">
        <Minus className="size-4" />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }}
      >
        Fit
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setZoom(1)}>
        100%
      </Button>
      <Button type="button" size="icon-sm" variant="outline" onClick={() => setZoom((z) => Math.min(6, z + 0.25))} aria-label="Zoom in">
        <Plus className="size-4" />
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setFull((v) => !v)}>
        {full ? "Exit large view" : "Large view"}
      </Button>
    </div>
  );
  if (full) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col gap-3 bg-bg p-3">
        {viewer}
        {controls}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {viewer}
      {controls}
    </div>
  );
}
