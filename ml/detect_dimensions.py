"""Phase 1 Inference: 'WHERE IS A DIMENSION?' - Detect dimension regions on engineering drawings."""

import sys
import argparse
from pathlib import Path

import cv2
import torch
from ultralytics import YOLO


ML_DIR = Path(__file__).resolve().parent
BEST_PT = ML_DIR / "runs" / "detect" / "phase1_where_is_dimension" / "weights" / "best.pt"
OUTPUT_DIR = ML_DIR / "runs" / "detect" / "phase1_test"
CLASS_NAME = "dimension"


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect dimension regions on engineering drawings")
    parser.add_argument("--image", type=str, required=True, help="Path to engineering drawing image")
    parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold (default: 0.25)")
    parser.add_argument("--device", type=str, default="auto", help="Device: auto, cuda, cpu (default: auto)")
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        print(f"ERROR: Image not found: {image_path}", flush=True)
        return 1

    if not BEST_PT.exists():
        print(f"ERROR: Model weights not found: {BEST_PT}", flush=True)
        return 1

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"

    print(f"[inference] device={device}", flush=True)
    print(f"[inference] model={BEST_PT}", flush=True)
    print(f"[inference] image={image_path}", flush=True)
    print(f"[inference] conf={args.conf}", flush=True)

    model = YOLO(str(BEST_PT))

    results = model.predict(
        source=str(image_path),
        conf=args.conf,
        device=device,
        save=False,
        verbose=True,
    )

    img = cv2.imread(str(image_path))
    if img is None:
        print(f"ERROR: Could not read image: {image_path}", flush=True)
        return 1

    detections = 0
    for result in results:
        boxes = result.boxes
        if boxes is not None:
            for box in boxes:
                xyxy = box.xyxy[0].cpu().numpy().astype(int)
                conf = float(box.conf[0].cpu().numpy())
                cls_id = int(box.cls[0].cpu().numpy())

                x1, y1, x2, y2 = xyxy

                cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 0), 2)

                label = f"{CLASS_NAME} {conf:.2f}"
                (label_w, label_h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
                cv2.rectangle(img, (x1, y1 - label_h - 8), (x1 + label_w + 4, y1), (0, 255, 0), -1)
                cv2.putText(img, label, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

                detections += 1
                print(f"  Detection {detections}: bbox=({x1},{y1},{x2},{y2}) conf={conf:.4f} class={CLASS_NAME}", flush=True)

    output_path = OUTPUT_DIR / f"{image_path.stem}_annotated{image_path.suffix}"
    cv2.imwrite(str(output_path), img)

    print(f"[inference] detections={detections}", flush=True)
    print(f"[inference] saved={output_path}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())