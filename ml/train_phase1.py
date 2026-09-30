"""Phase 1: 'WHERE IS A DIMENSION?' - YOLO dimension-region detector training.

Single class (dimension) bounding-box detection only.
No OCR, no value extraction, no GD&T, no ballooning.
"""

import sys
from pathlib import Path

import torch
from ultralytics import YOLO

ML_DIR = Path(__file__).resolve().parent
DATA_YAML = ML_DIR / "dataset" / "data.yaml"
PRETRAINED = ML_DIR / "pretrained" / "yolo11n.pt"
PROJECT = ML_DIR / "runs" / "detect"
RUN_NAME = "phase1_where_is_dimension"

EPOCHS = 50
IMGSZ = 640
BATCH = 8


def main() -> int:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if not PRETRAINED.exists():
        raise FileNotFoundError(f"pretrained weights not found: {PRETRAINED}")
    if not DATA_YAML.exists():
        raise FileNotFoundError(f"data yaml not found: {DATA_YAML}")

    print(f"[phase1] device={device}", flush=True)
    print(f"[phase1] model={PRETRAINED}", flush=True)
    print(f"[phase1] data={DATA_YAML}", flush=True)
    print(f"[phase1] epochs={EPOCHS} imgsz={IMGSZ} batch={BATCH}", flush=True)

    model = YOLO(str(PRETRAINED))

    results = model.train(
        data=str(DATA_YAML),
        epochs=EPOCHS,
        imgsz=IMGSZ,
        batch=BATCH,
        device=device,
        project=str(PROJECT),
        name=RUN_NAME,
        exist_ok=True,
        workers=0,
        cache=False,
        patience=0,
        plots=True,
        verbose=True,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    last = Path(results.save_dir) / "weights" / "last.pt"
    print(f"[phase1] save_dir={results.save_dir}", flush=True)
    print(f"[phase1] best.pt exists={best.exists()} path={best}", flush=True)
    print(f"[phase1] last.pt exists={last.exists()} path={last}", flush=True)
    if not best.exists():
        print("[phase1] ERROR: best.pt missing", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
