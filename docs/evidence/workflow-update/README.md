# Codex workflow validation record

Base inspected and tested: `2521c65085e3640d4f16a194db991305637e64ac`.
This change adds the previously absent `.github/workflows/codex-coding.yml`.
It does not claim to recover unpublished application changes from earlier chat.

## Executed checks

Node v24.19.0, npm 11.9.0, Python 3.12.14 environment (workflow selects 3.11); see installation logs for resolved Python packages.

| Command | Actual result |
| --- | --- |
| `npm ci` | Passed; 498 packages installed; npm proxy-config and deprecated Recharts warnings |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, 0 errors and 6 warnings; full warning locations in lint.log |
| `npm test` | Passed, 142 tests, 0 failed/skipped |
| `npm run check:auth` | Exit 2; dev auth configuration could not be read, including recheck |
| `npm run build` | Passed; inlineDynamicImports/codeSplitting warning; database migration skipped because DATABASE_URL is absent |
| `npx playwright install chromium` | Failed; downloaded archive invalid/truncated |
| `npm run dev` | Failed with uv_interface_addresses runtime error |
| `npm run dev -- --host 127.0.0.1` | Vite started; this alone does not verify application behavior |
| `node scripts/browser-smoke.mjs http://127.0.0.1:8080/ docs/evidence/workflow-update/browser.png` | Exit 1; Chromium executable missing |
| YAML parse, embedded Bash syntax, action input names | Passed against pinned action definition; workflow itself NOT RUN |

Logs preserve output except that the checkout prefix is replaced by repository-relative paths.
`checks.json` records individual application check exit codes. The original auth result is
retained separately from the recheck. Browser failure JSON is evidence of failure, not a screenshot.

## Models and missing validation

`model-hashes.json` hashes actual binary files. Existing weights remain part of this branch:
`public/models/card-det.onnx`, `models/card-seg/v1/best.onnx`, and `models/card-seg/v1/best.pt`.
The ONNX copies match. ONNX Runtime 1.30.0 successfully loaded the deployed detector:
input `images`, float32 `[1,3,640,640]`; output `output0`, float32 `[1,5,8400]`.
This is a load check, not a precision/recall measurement.

The application defines confidence 0.15, NMS IoU 0.45, and input size 640 in
`src/lib/yolo.ts`. Exact application evaluation remains NOT COMPLETED: browser Canvas
preprocessing and application filtering were not executed because Chromium installation
failed. No numerical precision/recall, optimal-F1 result, or formula result is asserted.
The earlier referenced `scripts/validate_card_yolo.py` and dataset manifest are absent
from this base. No Python test suite was found for that evaluator.

The independent benchmark remains BLOCKED: no independently verified, disjoint labeled
benchmark was identified. `scripts/train_card_yolo.py` generates labels heuristically;
the existing validation split cannot be called an independent benchmark. Existing model
metadata metrics are historical, unverified claims and are not this run's results.
The training script also contains a hard-coded `/workspace` root; the new workflow
explicitly directs subsequent implementation to replace old absolute paths.

Review-controls and formula changes described in earlier status prose were unavailable
on the inspected branch. They are not invented or marked complete here.

## Workflow behavior and prerequisites

Manual dispatch only, contents/pull-requests write scope, GH_TOKEN from github.token,
supported `sandbox: danger-full-access` with `safety-strategy: drop-sudo`, and pinned
Codex action commit `86365089eb2b84e0a8fb0717b304f8bdcb13b20e`. Task instructions
live in prompt; final status goes to a separate output file. Evidence upload always runs.
Model artifact paths include both the requested future card-det directory and existing weights.

Requires a configured OPENAI_API_KEY repository secret, enabled Actions, allowed draft-PR
creation by GITHUB_TOKEN, and working package/browser downloads. Secret availability and
organization policy were not verified. No workflow dispatch, merge or deployment is claimed.
The workflow must reach the default branch before normal manual dispatch availability.

Reproduce application checks with the commands above after `npm ci`. Reproduce model
hashes with `sha256sum public/models/card-det.onnx models/card-seg/v1/best.onnx models/card-seg/v1/best.pt`.
Remote verification receipts belong outside the commit they describe.
