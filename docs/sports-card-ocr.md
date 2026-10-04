# Sports-card OCR and detector training

The studio now exposes an editable OCR review threshold, original transcription,
measured engine scores, missing printed fields, and the history of recognition
passes. Exported manifests include this evidence. Filename metadata remains a
separate hint and cannot supply printed fields or raise the OCR score.

Recognition tries Paddle text lines, the original image, selected Tesseract text
lines, contrast, the bottom nameplate, inversion, and a 180-degree rotation. It
stops when the selected pass meets the threshold and contains player,
manufacturer, year, and set. Passes from different rotations are not concatenated.
Line crops preserve aspect ratio. Crop boxes refer to pixels in that recognition
pass, before any later manual rotation or enhancement.

Complete passes that meet the threshold outrank incomplete passes, without
raising their recorded scores. Text boxes on the same row are read left to right.
A failed crop can restart the worker once and continue whole-image retries;
cleanup is bounded even if a worker fails to load. Optional vision transcriptions
appear as selected, unmeasured passes in the evidence history. The preview shows
valid zero scores and never relabels legacy identity confidence as an OCR score.

Parser checks cover vintage years, accented names, specific product names,
numbered parallels including 1/1, and explicitly marked card numbers. Ordinary
hyphenated text such as ALL-STAR cannot become an unmarked card number.
Adjacent singleton name fragments are joined for matching while complete lines
and blank lines remain boundaries; original line breaks stay in the transcription.
Manufacturer-adjacent and copyright years use the same
1900-to-current-year bound as other year matches.

## Formula computation

The supplied CSV contains 26 keyword matches from 11 chat screenshots. It is
review-triage evidence, not sports-card training labels or OCR reference text.
At threshold 80, the application rule computes **18 READY and 8 REVIEW rows**;
all **26 bounding boxes** agree with their coordinate columns.

The Formula Genius status formula is implemented in `src/lib/ocr-quality.ts`:

```excel
=IF(C2="","MISSING",IFERROR(IF(OR(NOT(ISNUMBER(C2)),C2<0,C2>100),"INVALID",IF(C2<Settings!$B$2,"REVIEW","READY")),"INVALID"))
```

Formula Genius reported verification skipped, 0 of 0 tests. The counts above
were computed locally using the application implementation. The source digest,
counts, and formula are recorded in `evidence/ocr-input-summary.json`; private
chat transcription was not added to this repository. READY means ready for the
review workflow, not a calibrated probability that the text is correct. Missing
required card fields can still make an otherwise high-scoring card require review.

## Completed YOLO run

YOLO11n was trained on the repository's 84 existing card images for 30 epochs on
CPU, at 640 pixels, seed 42. The deterministic split has 66 training and 18
validation images. Paired front/back scans stay in the same split, identical
decoded images are deduplicated, and polygon labels become detection boxes.
The labels originate from repository heuristics, not independent human annotation.

| Measurement | Result | Scope |
| --- | ---: | --- |
| mAP50 | 0.9892 | Ultralytics validation against heuristic boxes |
| mAP50–95 | 0.8092 | Ultralytics validation against heuristic boxes |
| Precision at max F1 | 0.9282 | Ultralytics-selected operating point |
| Recall at max F1 | 1.0000 | Ultralytics-selected operating point |
| Exported ONNX matching detections | 18 / 18 | Consumer rules, cutoff 0.15, match IoU 0.5 |
| Exported ONNX extra detections | 0 | Same 18-image development split |

The consumer check runs the exported ONNX on CPU with centered letterboxing,
decode, NMS at IoU 0.45, and the studio's single-class fitness rules. PIL bilinear
resize approximates browser canvas resize; it does not replace browser testing.
Full-frame scans are accepted for the fine-tuned card model. COCO fallback
models retain their conservative area and person filters.

Promotion requires finite metrics, 640-pixel input, mAP50 >= 0.90, mAP50–95 >=
0.75, and fixed-cutoff consumer precision and recall >= 0.90. An earlier short
candidate failed the operational check and was not retained as the browser model.
The promoted checkpoint, ONNX, dataset digest, and metrics are linked in
`models/card-det/v2/metadata.json`. Per-image checks, split manifest, training
receipt, and all 30 epochs are retained in `docs/evidence`.

The prior browser model also matches all 18 images under the corrected consumer
rules (`evidence/yolo-baseline-check.json`). It previously saw images in this
corpus. These results establish compatibility on this development set, not a
model accuracy improvement. No independent OCR transcriptions were supplied,
so character error rate and field accuracy have not been measured.

## Reproduce

From the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build

uv venv .venv-yolo
uv pip install --python .venv-yolo/bin/python --torch-backend cpu -r scripts/requirements-yolo.txt
.venv-yolo/bin/python -m unittest discover -s scripts -p test_train_card_yolo.py
.venv-yolo/bin/python scripts/train_card_yolo.py --output data/runs/my-card-run --epochs 30 --promote
.venv-yolo/bin/python scripts/validate_card_yolo.py \
  --model public/models/card-det.onnx \
  --source data/card-det \
  --manifest docs/evidence/yolo-dataset-manifest.json \
  --output data/runs/export-check.json
```

The trainer refuses to overwrite an existing dataset. Use a new output directory
for each run. `--prepare-only` validates and splits data without training;
omit `--promote` to retain a candidate without replacing browser weights.

The product design changes extend the existing workbench. Browser visual
verification remains incomplete because the session browser could not reach the
local preview. The build and application tests validate code integration; a
manual browser pass and a new human-labeled holdout are the next validation steps.
