# Runtime results

Run: https://github.com/claudepersonal/CardEnhance/actions/runs/37247923063

Tested application/evaluator commit: 8e24d9ef05561173a954378f5faeb8141b1b7d9a.

All 142 unit tests, typecheck, lint, build and auth checks passed; lint retains six warnings. Browser smoke exit 2: desktop reported React invalid-hook/useContext errors; mobile returned HTTP 200 with no console/page errors or overflow. An earlier run passed both viewports, so browser behavior is not consistently verified.

The actual card-detector path ran in Chromium with confidence 0.15, matching IoU 0.5, actual application preprocessing/decoding/fitness filtering/NMS, and COCO fallback disabled for isolation. On 17 existing heuristic validation labels: TP=3, FP=0, FN=14, precision=1.0, recall=0.17647058823529413. This is NOT an independent benchmark or an acceptable release result. Full per-image results and hashes are in yolo-browser-fixed-threshold.json. Optimal-F1 metrics were not measured. Independently verified disjoint benchmark labels are unavailable.

Artifact upload now succeeds after removing a colon from a historical log filename. Artifact: https://github.com/claudepersonal/CardEnhance/actions/runs/37247923063/artifacts/11319309211 . ZIP SHA-256: 9794a673430918169732db8c3ad559202a907db033284f9654e16984ca7a30e2 .

The Codex coding stage failed its prerequisite: OPENAI_API_KEY was empty. No autonomous Codex implementation, merge or production deployment occurred. The deterministic checks execute before that gate and do not need this secret.

Outstanding: correct poor detector recall and verify against independent labels; resolve intermittent desktop React hook error; configure OPENAI_API_KEY through repository Actions secrets for the Codex stage. Existing model weights were measured without modification.
