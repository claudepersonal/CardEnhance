#!/usr/bin/env python3
"""Evaluate an exported detector against the recorded validation split."""

import argparse
import hashlib
import json
from pathlib import Path

from train_card_yolo import evaluate_browser_onnx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=Path("data/card-det"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    import onnxruntime as ort

    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    receipt = evaluate_browser_onnx(
        session, json.loads(args.manifest.read_text()), args.source
    )
    receipt["model_sha256"] = hashlib.sha256(args.model.read_bytes()).hexdigest()
    receipt["dataset_sha256"] = hashlib.sha256(args.manifest.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k: v for k, v in receipt.items() if k != "records"}, indent=2))


if __name__ == "__main__":
    main()
