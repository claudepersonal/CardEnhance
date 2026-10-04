#!/usr/bin/env python3
"""Portable YOLO training. Existing heuristic labels are development evidence only."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def detection_label(text: str) -> str:
    """Validate boxes/polygons and convert polygons to single-class boxes."""
    lines = []
    for line in text.splitlines():
        if not line.strip():
            continue
        values = [float(value) for value in line.split()]
        if values[0] != 0 or not all(math.isfinite(v) for v in values):
            raise ValueError("Expected finite single-class card labels")
        coords = values[1:]
        if any(v < 0 or v > 1 for v in coords):
            raise ValueError("Coordinates must be normalized to 0..1")
        if len(coords) == 4:
            x, y, width, height = coords
            if (
                x - width / 2 < -1e-6
                or x + width / 2 > 1 + 1e-6
                or y - height / 2 < -1e-6
                or y + height / 2 > 1 + 1e-6
            ):
                raise ValueError("Box extends outside image")
        elif len(coords) >= 6 and len(coords) % 2 == 0:
            xs, ys = coords[::2], coords[1::2]
            width, height = max(xs) - min(xs), max(ys) - min(ys)
            x, y = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
        else:
            raise ValueError("Expected a box or polygon")
        if width <= 0 or height <= 0:
            raise ValueError("Degenerate card box")
        lines.append(f"0 {x:.6f} {y:.6f} {width:.6f} {height:.6f}")
    return "\n".join(lines) + ("\n" if lines else "")


def source_group(path: Path, digest: str) -> str:
    # This scanner lot pairs an odd back scan with the next even front scan.
    match = re.search(r"Year-Manfucturer-Card-(\d{4})", path.stem, re.IGNORECASE)
    if match and 199 <= int(match[1]) <= 267:
        return f"scanner-pair-{(int(match[1]) - 199) // 2}"
    stem = re.sub(r"^\d{4}_", "", path.stem)
    stem = re.sub(r"[-_](front|back)$", "", stem, flags=re.IGNORECASE)
    return f"source-{stem}" if stem else digest


def build_dataset(source: Path, output: Path, seed: int) -> dict:
    from PIL import Image

    if output.exists():
        raise ValueError(f"Refusing to overwrite existing dataset: {output}")
    records, seen, duplicates = [], {}, 0
    for image in sorted((source / "images").rglob("*")):
        if image.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        label = (
            source / "labels" / image.relative_to(source / "images").with_suffix(".txt")
        )
        if not label.exists():
            raise ValueError(f"Missing label: {label}")
        normalized = detection_label(label.read_text())
        with Image.open(image) as opened:
            rgb = opened.convert("RGB")
            if min(rgb.size) < 32:
                raise ValueError(f"Image too small: {image}")
            digest = hashlib.sha256(str(rgb.size).encode() + rgb.tobytes()).hexdigest()
        if digest in seen:
            if seen[digest] != normalized:
                raise ValueError(f"Duplicate image with conflicting labels: {image}")
            duplicates += 1
            continue
        seen[digest] = normalized
        records.append(
            {
                "source": image,
                "label": normalized,
                "sha256": digest,
                "group": source_group(image, digest),
            }
        )
    groups = sorted(
        {r["group"] for r in records},
        key=lambda g: hashlib.sha256(f"{seed}:{g}".encode()).hexdigest(),
    )
    if len(groups) < 5:
        raise ValueError("Need at least five independent source groups")
    validation = set(groups[: max(1, round(len(groups) * 0.2))])
    counts, manifest = {"train": 0, "val": 0}, []
    for record in records:
        split = "val" if record["group"] in validation else "train"
        for kind in ("images", "labels"):
            (output / kind / split).mkdir(parents=True, exist_ok=True)
        image, name = record["source"], record["sha256"][:16]
        shutil.copy2(image, output / "images" / split / f"{name}{image.suffix.lower()}")
        (output / "labels" / split / f"{name}.txt").write_text(record["label"])
        counts[split] += 1
        manifest.append(
            {
                "source": image.relative_to(source).as_posix(),
                "sha256": record["sha256"],
                "group": record["group"],
                "split": split,
                "label": record["label"].strip(),
            }
        )
    dataset = {
        "counts": counts,
        "duplicates_removed": duplicates,
        "seed": seed,
        "label_provenance": "repository_heuristic_polygons",
        "validation_scope": "development label agreement; not independent human annotations",
        "records": manifest,
    }
    (output / "manifest.json").write_text(json.dumps(dataset, indent=2) + "\n")
    (output / "card.yaml").write_text(
        f"path: {json.dumps(str(output.resolve()))}\ntrain: images/train\nval: images/val\nnames:\n  0: card\n"
    )
    return dataset


def promotion_allowed(
    imgsz: int, map50: float, map95: float, precision: float, recall: float
) -> bool:
    return (
        imgsz == 640
        and all(math.isfinite(v) for v in (map50, map95, precision, recall))
        and map50 >= 0.9
        and map95 >= 0.75
        and precision >= 0.9
        and recall >= 0.9
    )


def box_iou(a: list, b: list) -> float:
    intersection = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])) * max(
        0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    )
    union = a[2] * a[3] + b[2] * b[3] - intersection
    return intersection / union if union > 0 else 0


def browser_boxes(predictions: list, width: int, height: int, imgsz: int = 640) -> list:
    """Single-class decode/NMS/fitness contract in src/lib/yolo.ts (xywh+score)."""
    scale = imgsz / max(width, height)
    pad_x = (imgsz - max(1, math.floor(width * scale + 0.5))) // 2
    pad_y = (imgsz - max(1, math.floor(height * scale + 0.5))) // 2
    raw = []
    for cx, cy, bw, bh, score in predictions:
        if (
            not all(math.isfinite(float(v)) for v in (cx, cy, bw, bh, score))
            or not 0.15 <= score <= 1
            or bw <= 0
            or bh <= 0
        ):
            continue
        x, y = max(0, cx - bw / 2), max(0, cy - bh / 2)
        right, bottom = min(imgsz, cx + bw / 2), min(imgsz, cy + bh / 2)
        if right - x >= 8 and bottom - y >= 8:
            raw.append([x, y, right - x, bottom - y, float(score)])
    kept = []
    for box in sorted(raw, key=lambda b: b[4], reverse=True):
        if all(box_iou(box, prior) < 0.45 for prior in kept):
            kept.append(box)
        if len(kept) == 16:
            break
    boxes = []
    for x, y, bw, bh, score in kept:
        left, top = max(0, (x - pad_x) / scale), max(0, (y - pad_y) / scale)
        right, bottom = (
            min(width, (x + bw - pad_x) / scale),
            min(height, (y + bh - pad_y) / scale),
        )
        w, h = right - left, bottom - top
        if w < 8 or h < 8:
            continue
        area, aspect = w * h / (width * height), w / h
        if 0.12 <= area <= 1 and (0.48 <= aspect <= 0.92 or 1.08 <= aspect <= 2.2):
            boxes.append([left, top, w, h, score])

    def fitness(box):
        area = box[2] * box[3] / (width * height)
        portrait = 0.48 <= box[2] / box[3] <= 0.92
        return box[4] + 0.28 + (0.08 if portrait else 0) + min(0.18, area * 0.4)

    final = []
    # Browser NMS re-sorts by raw score; preserve fitness order only for ties.
    ranked = sorted(boxes, key=fitness, reverse=True)
    for box in sorted(ranked, key=lambda b: b[4], reverse=True):
        if all(box_iou(box, prior) < 0.45 for prior in final):
            final.append(box)
    return final[:32]


def evaluate_browser_onnx(
    session, dataset: dict, source: Path, imgsz: int = 640
) -> dict:
    """Fixed-cutoff consumer check; PIL bilinear approximates browser canvas resize."""
    import numpy as np
    from PIL import Image

    records, tp, fp, fn = [], 0, 0, 0
    for row in dataset["records"]:
        if row["split"] != "val":
            continue
        with Image.open(source / row["source"]) as opened:
            image = opened.convert("RGB")
            width, height = image.size
            scale = imgsz / max(width, height)
            w, h = (
                max(1, math.floor(width * scale + 0.5)),
                max(1, math.floor(height * scale + 0.5)),
            )
            canvas = Image.new("RGB", (imgsz, imgsz), (114, 114, 114))
            canvas.paste(
                image.resize((w, h), Image.Resampling.BILINEAR),
                ((imgsz - w) // 2, (imgsz - h) // 2),
            )
            tensor = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255
        output = session.run(None, {session.get_inputs()[0].name: tensor})[0]
        if (
            output.ndim != 3
            or output.shape[:2] != (1, 5)
            or not np.isfinite(output).all()
        ):
            raise ValueError(f"Invalid exported detector output: {output.shape}")
        boxes = browser_boxes(output[0].T.tolist(), width, height, imgsz)
        targets = []
        for label in row["label"].splitlines():
            _, cx, cy, bw, bh = map(float, label.split())
            targets.append(
                [(cx - bw / 2) * width, (cy - bh / 2) * height, bw * width, bh * height]
            )
        matched, correct = set(), 0
        for box in sorted(boxes, key=lambda b: b[4], reverse=True):
            available = [
                (box_iou(box, target), i)
                for i, target in enumerate(targets)
                if i not in matched
            ]
            overlap, index = max(available, default=(0, -1))
            if overlap >= 0.5:
                matched.add(index)
                correct += 1
        tp += correct
        fp += len(boxes) - correct
        fn += len(targets) - correct
        records.append(
            {
                "source": row["source"],
                "width": width,
                "height": height,
                "accepted": bool(boxes),
                "true_positive": correct,
                "false_positive": len(boxes) - correct,
                "false_negative": len(targets) - correct,
                "boxes": boxes,
            }
        )
    if not records:
        raise ValueError("No validation images to evaluate")
    return {
        "validation_scope": "heuristic label agreement; CPU ONNX with browser decode/NMS/fitness contract; PIL bilinear approximates canvas resize",
        "confidence_cutoff": 0.15,
        "nms_iou": 0.45,
        "match_iou": 0.5,
        "images": len(records),
        "accepted_images": sum(r["accepted"] for r in records),
        "true_positive": tp,
        "false_positive": fp,
        "false_negative": fn,
        "precision": tp / (tp + fp) if tp + fp else 0,
        "recall": tp / (tp + fn) if tp + fn else 0,
        "records": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "data/card-det")
    parser.add_argument(
        "--output", type=Path, default=ROOT / "data/runs/sports-card-yolo"
    )
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument(
        "--promote",
        action="store_true",
        help="Replace browser model after development gates pass",
    )
    args = parser.parse_args()
    args.source = args.source.resolve()
    args.output = args.output.resolve()
    if min(args.epochs, args.imgsz, args.batch, args.threads) < 1:
        parser.error("epochs, imgsz, batch, and threads must be positive")
    dataset = build_dataset(args.source, args.output / "dataset", args.seed)
    print(json.dumps({k: v for k, v in dataset.items() if k != "records"}), flush=True)
    if args.prepare_only:
        return
    import numpy as np
    import onnxruntime as ort
    import torch
    import ultralytics
    from ultralytics import YOLO

    torch.set_num_threads(args.threads)
    model = YOLO(args.model)
    results = model.train(
        data=str(args.output / "dataset/card.yaml"),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        workers=0,
        seed=args.seed,
        deterministic=True,
        patience=0,
        conf=0.15,
        project=str(args.output),
        name="training",
        exist_ok=False,
        optimizer="AdamW",
        lr0=0.001,
        hsv_h=0.015,
        hsv_s=0.35,
        hsv_v=0.3,
        degrees=12,
        translate=0.1,
        scale=0.3,
        perspective=0.0005,
        fliplr=0.0,
        flipud=0.0,
        mosaic=0.3,
        close_mosaic=3,
        amp=False,
        plots=True,
    )
    best = Path(results.save_dir) / "weights/best.pt"
    trained = YOLO(str(best))
    exported = Path(
        trained.export(
            format="onnx",
            imgsz=args.imgsz,
            simplify=True,
            opset=17,
            dynamic=False,
            nms=False,
        )
    )
    session = ort.InferenceSession(str(exported), providers=["CPUExecutionProvider"])
    output = session.run(
        None,
        {
            session.get_inputs()[0].name: np.zeros(
                (1, 3, args.imgsz, args.imgsz), np.float32
            )
        },
    )[0]
    if not np.isfinite(output).all() or output.shape[0] != 1 or output.shape[1] != 5:
        raise ValueError(f"Unexpected browser detector output: {output.shape}")
    if not math.isfinite(float(results.box.map50)) or not math.isfinite(
        float(results.box.map)
    ):
        raise ValueError("Nonfinite training metrics")
    validation = evaluate_browser_onnx(session, dataset, args.source, args.imgsz)
    (args.output / "browser-validation.json").write_text(
        json.dumps(validation, indent=2) + "\n"
    )
    receipt = {
        "counts": dataset["counts"],
        "duplicates_removed": dataset["duplicates_removed"],
        "label_provenance": dataset["label_provenance"],
        "validation_scope": dataset["validation_scope"],
        "epochs_requested": args.epochs,
        "epochs_completed": len(
            (Path(results.save_dir) / "results.csv").read_text().splitlines()
        )
        - 1,
        "imgsz": args.imgsz,
        "device": args.device,
        "seed": args.seed,
        "model": args.model,
        "ultralytics_version": ultralytics.__version__,
        "torch_version": torch.__version__,
        "confidence_cutoff": 0.15,
        "precision_at_max_f1": float(results.box.mp),
        "recall_at_max_f1": float(results.box.mr),
        "browser_validation": {k: v for k, v in validation.items() if k != "records"},
        "map50": float(results.box.map50),
        "map50_95": float(results.box.map),
        "weights_sha256": hashlib.sha256(best.read_bytes()).hexdigest(),
        "onnx_sha256": hashlib.sha256(exported.read_bytes()).hexdigest(),
        "dataset_sha256": hashlib.sha256(
            (args.output / "dataset/manifest.json").read_bytes()
        ).hexdigest(),
        "onnx_output_shape": list(output.shape),
        "promoted": False,
    }
    # Always preserve a completed candidate receipt even when promotion is refused.
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if args.promote:
        if not promotion_allowed(
            args.imgsz,
            receipt["map50"],
            receipt["map50_95"],
            validation["precision"],
            validation["recall"],
        ):
            raise ValueError("Candidate did not meet development promotion criteria")
        target = ROOT / "models/card-det/v2"
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best, target / "best.pt")
        shutil.copy2(exported, target / "best.onnx")
        shutil.copy2(exported, ROOT / "public/models/card-det.onnx")
        receipt["promoted"] = True
        (target / "metadata.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2), flush=True)


if __name__ == "__main__":
    main()
