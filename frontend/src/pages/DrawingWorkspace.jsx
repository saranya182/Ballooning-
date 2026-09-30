import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  ZoomIn,
  ZoomOut,
  Save,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Wand2,
  Eraser,
  Loader2,
  Plus,
  Table2,
  Download
} from 'lucide-react';

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createWorker } from 'tesseract.js';
import * as XLSX from 'xlsx';

import api from '../services/api';
import { enhanceDetections } from '../utils/engineeringDetection';
import { contextualFilter } from '../utils/contextualFilter';
import { detectPatterns } from '../utils/patternMatcher';
import {
  normalizeCallout,
  composeSpecification,
  parseCalloutText
} from '../utils/calloutFormat';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/* Pointer travel (device px) below this counts as a click; anything
   above is a drag and must never re-read / overwrite a value. */
const DRAG_CLICK_THRESHOLD = 5;

/* =========================================================
   DETECTION HELPERS (shared by Auto Detect, Add Dimension
   and balloon drop re-reads)
========================================================= */

const normalizeDetectionText = (value) => {
  let val = String(value || '').trim().replace(/\s+/g, ' ');
  return val
    .replace(/[−–—]/g, '-')
    .replace(/[＋]/g, '+')
    .replace(/[Øø]/g, 'Ø')
    .replace(/^[OQo0]\s*(?=\d)/i, 'Ø') // Converts Q19, O19, 019 to Ø19
    .replace(/(?:^|\s)[vV]\s*(?=\d)/g, ' ↧ ') // Converts v 7 to ↧ 7 (depth)
    .replace(/(?:^|\s)[uU]\s*(?=\d)/g, ' ⌴ ') // Converts U 14 to ⌴ 14 (counterbore)
    .replace(/(?:^|\s)[xX]\s*(?=\d)/g, ' × ') // Multiplier
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\s+/g, ' ').trim();
};

const DETECTION_PATTERNS = {
  tolerance:
    /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*\d+(?:\.\d+)?\s*(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?\s*(?:THRU|ALL|DP|DEEP|TYP|PLACES|MAX|MIN)*\s*$/i,
  bilateral:
    /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*\d+(?:\.\d+)?\s*[+＋]\s*\d+(?:\.\d+)?\s*(?:\/|\s)\s*[-−]\s*\d+(?:\.\d+)?\s*(?:THRU|ALL|DP|DEEP|TYP|PLACES|MAX|MIN)*\s*$/i,
  diameter: /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*Ø\s*\d+(?:\.\d+)?\s*$/i,
  radius: /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*R\s*\d+(?:\.\d+)?\s*$/i,
  dimension:
    /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*\d{1,4}(?:\.\d{1,4})?(?:\s*(?:mm|in|inch|inches|THRU|ALL|DP|DEEP|TYP|PLACES|MAX|MIN|REF))*\s*$/i,
  smallTolerance: /^\s*[+\-±]?\s*0?\.\d{1,3}\s*$/,
  fit:
    /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*\d+(?:\.\d+)?\s*[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?\s*$/i,
  angle: /^\s*\d+(?:\.\d+)?\s*°\s*$/,
  angleTolerance:
    /^\s*\d+(?:\.\d+)?\s*°\s*±\s*\d+(?:\.\d+)?\s*$/,
  angularToleranceLine: /^\s*±\s*\d+(?:\.\d+)?\s*°\s*$/,
  bareFit:
    /^\s*[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?\s*$/i,
  thread:
    /^\s*M\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?\s*$/i,
  datumFeature: /^\s*\d+(?:\.\d+)?\s*[A-Z]\s*$/,
  symbol: /^\s*(Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|⌵|x)\s*$/i
};

const isDimensionPattern = (text) =>
  DETECTION_PATTERNS.dimension.test(text) ||
  DETECTION_PATTERNS.diameter.test(text) ||
  DETECTION_PATTERNS.radius.test(text) ||
  DETECTION_PATTERNS.tolerance.test(text) ||
  DETECTION_PATTERNS.bilateral.test(text) ||
  DETECTION_PATTERNS.fit.test(text) ||
  DETECTION_PATTERNS.thread.test(text) ||
  DETECTION_PATTERNS.angle.test(text) ||
  DETECTION_PATTERNS.angleTolerance.test(text);

/*
  A reading is only usable when its VALUE reads as a real callout:
  at least one digit, and the callout parser accepts it as confident.
  This drops OCR noise ("[}", "C1") and tolerance-only lines
  ("±0.05", "0.05/0.03") that carry no nominal - storing those is
  worse than storing nothing, because the panel then shows a value
  that does not exist on the drawing.
*/
const isReadableCallout = (parsed) => {
  const value = String(
    (parsed && parsed.value) || ''
  ).trim();

  if (!/\d/.test(value)) {
    return false;
  }

  /*
    A nominal of zero ("0", "00", "Ø0", "0.00") is not a dimension -
    it is a stray glyph, most often a fragment picked up by one of the
    rotated OCR passes or a tolerance line with no nominal on it.
    parseNearestDimension will happily build "Ø0" out of a single "0"
    that matches the standalone-symbol pattern, and because the rotated
    passes often land inside the dragged box while the real callout
    scores no higher, that junk used to WIN and the side panel then
    showed "Ø 0" with 0.00 tolerances instead of the actual value.
    Real callouts always carry a non-zero digit ("0.5" survives), and
    an all-zero reading still reaches the best-effort fallback when
    nothing better was read.
  */
  if (!/[1-9]/.test(value)) {
    return false;
  }

  const parts = parseCalloutText(value);
  return !!(parts && parts.confident);
};

const isDetectionText = (rawText, options = {}) => {
  const text = normalizeDetectionText(rawText);

  if (!text) {
    return false;
  }

  if (
    /^(A[0-4]|REV|DATE|DESCRIPTION|WEIGHT|SHEET|SCALE)$/i.test(
      text
    )
  ) {
    return false;
  }

  if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(text)) {
    return false;
  }

  if (/\d+[-_/]\d+[-_/]\d+/.test(text)) {
    return false;
  }

  /*
    A bare 4+ digit run is normally a drawing number or a date, so it
    is skipped during auto-detection - but when the operator dragged a
    box over it they are pointing straight at the value, and real
    dimensions like 1000 / 2500 would otherwise never be read.
  */
  if (!options.allowLongNumbers && /^\d{4,}$/.test(text)) {
    return false;
  }

  return true; // Always allow any text/number during manual ballooning
};

/*
  mat maps text space -> canvas device pixels. Dimension callouts are
  often rotated (vertical Ø callouts), and then the baseline no longer
  runs along +x, so the centre has to be projected along the real text
  direction instead of being assumed horizontal.
*/
const textAxes = (item) => {
  const mat = item && item.mat;

  if (!mat || mat.length < 4) {
    return null;
  }

  const alongLength = Math.hypot(mat[0], mat[1]);
  const upLength = Math.hypot(mat[2], mat[3]);

  if (!(alongLength > 0) || !(upLength > 0)) {
    return null;
  }

  return {
    along: [mat[0] / alongLength, mat[1] / alongLength],
    up: [mat[2] / upLength, mat[3] / upLength]
  };
};

const detectionCenterX = (item) => {
  const width = Number(item.width || 0);
  const axes = item.source === 'ocr' ? null : textAxes(item);

  if (axes) {
    return (
      Number(item.x || 0) +
      axes.along[0] * (width / 2) +
      axes.up[0] * (Number(item.height || 0) / 2)
    );
  }

  return Number(item.x || 0) + width / 2;
};

// PDF text y is the BASELINE (bottom), OCR y is the TOP of the box.
const detectionCenterY = (item) => {
  const y = Number(item.y || 0);
  const height = Number(item.height || 0);

  if (item.source === 'ocr') {
    return y + height / 2;
  }

  const axes = textAxes(item);

  if (axes) {
    return (
      y +
      axes.along[1] * (Number(item.width || 0) / 2) +
      axes.up[1] * (height / 2)
    );
  }

  return y - height / 2;
};

/* Balloon positions are stored as page-relative fractions
   (0..1) so they stay locked to the same spot on the drawing
   at any zoom level. */
const clamp01 = (value) =>
  Math.max(0, Math.min(1, Number(value) || 0));

/* =========================================================
   STATUS
   Green checkmark = Verified (high confidence / selectable text)
   Orange warning  = Needs verification (OCR low confidence)
========================================================= */

const statusForDetection = (detected) => {
  if (!detected) {
    return 'Draft';
  }

  /*
    The reading pipeline could not parse the callout confidently and
    fell back to the raw OCR text - it must never look Verified.
  */
  if (detected.needsVerification) {
    return 'Needs verification';
  }

  if (detected.source === 'pdf') {
    return 'Verified';
  }

  return Number(detected.confidence || 0) >= 50
    ? 'Verified'
    : 'Needs verification';
};

/* =========================================================
   OCR / PDF CLUSTERING
   ---------------------------------------------------------
   OCR reads a single dimension callout as separate words
   (value line + +tolerance line + -tolerance line). Without
   grouping this becomes 2-3 balloons for ONE dimension.

   clusterDetectionsIntoDimensions merges words that sit
   close together (stacked value + tolerances) into a single
   detection so each dimension = ONE balloon.
========================================================= */

const clusterDetectionsIntoDimensions = (detections) => {
  if (!detections || detections.length === 0) {
    return [];
  }

  const items = detections
    .map((item) => ({
      ...item,
      text: normalizeDetectionText(item.text)
    }))
    .filter((item) => item.text);

  const clusterCenterX = (item) =>
    Number(item.x || 0) +
    Number(item.width || 0) / 2;

  const clusterCenterY = (item) =>
    item.source === 'ocr'
      ? Number(item.y || 0) +
        Number(item.height || 0) / 2
      : Number(item.y || 0) -
        Number(item.height || 0) / 2;

  const isFullToleranceText = (text) =>
    /^\s*(?:Ø\s*)?\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?\s*$/i.test(
      text
    ) ||
    /^\s*(?:Ø\s*)?\d+(?:\.\d+)?\s*[+＋]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?\s*$/i.test(
      text
    );

  const isToleranceLineText = (text) =>
    /^\s*[+-]?\s*0?\.\d{1,3}\s*$/i.test(text) ||
    /^\s*±\s*\d+(?:\.\d+)?\s*$/i.test(text) ||
    /^\s*±\s*\d+(?:\.\d+)?\s*°\s*$/i.test(text) ||
    /^\s*[+＋]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?\s*$/i.test(
      text
    );

  const toleranceNumber = (text) => {
    const match = normalizeDetectionText(text).match(
      /[+-±]?\s*(\d+(?:\.\d+)?)/
    );

    return match ? Number(match[1]) : null;
  };

  /* Cluster items that sit in the same spot. */

  const clusters = [];
  const used = new Set();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;

    const cluster = [items[i]];
    used.add(i);

    let grew = true;

    while (grew) {
      grew = false;

      for (let j = 0; j < items.length; j++) {
        if (used.has(j)) continue;

        const candidate = items[j];
        const overlaps = cluster.some((member) => {
          const dx = Math.abs(
            clusterCenterX(member) -
              clusterCenterX(candidate)
          );

          const dy = Math.abs(
            clusterCenterY(member) -
              clusterCenterY(candidate)
          );

          return dx <= 45 && dy <= 75;
        });

        if (overlaps) {
          cluster.push(candidate);
          used.add(j);
          grew = true;
        }
      }
    }

    clusters.push(cluster);
  }

  const result = [];

  for (const cluster of clusters) {
    const sorted = [...cluster].sort((a, b) => {
      const aComplete = isFullToleranceText(a.text)
        ? 0
        : 1;

      const bComplete = isFullToleranceText(b.text)
        ? 0
        : 1;

      if (aComplete !== bComplete) {
        return aComplete - bComplete;
      }

      /* The value line is usually the largest text. */

      const aHeight = Number(a.height || 0);
      const bHeight = Number(b.height || 0);

      if (Math.abs(aHeight - bHeight) > 0.5) {
        return bHeight - aHeight;
      }

      return (b.confidence || 0) - (a.confidence || 0);
    });

    const primary = sorted[0];

    if (!primary) continue;

    let combinedText = primary.text;

    /*
      Already a complete "25 ±0.05" reading.
      Skip merging, but still keep any other
      non-tolerance detections in the cluster.
    */

    const primaryIsComplete =
      isFullToleranceText(primary.text);

    if (!primaryIsComplete) {
      /*
        Collect tolerance lines that sit with the value.
        Stacked top-to-bottom: top = plus, bottom = minus.
      */

      const toleranceLines = sorted
        .slice(1)
        .filter((item) =>
          isToleranceLineText(item.text)
        )
        .sort(
          (a, b) =>
            clusterCenterY(a) - clusterCenterY(b)
        )
        .slice(0, 2);

      if (toleranceLines.length === 1) {
        const value = toleranceNumber(
          toleranceLines[0].text
        );

        if (Number.isFinite(value)) {
          combinedText =
            `${primary.text} ±${String(
              Number(value.toFixed(3))
            )}`;
        }
      } else if (toleranceLines.length >= 2) {
        const top = toleranceNumber(
          toleranceLines[0].text
        );

        const bottom = toleranceNumber(
          toleranceLines[1].text
        );

        if (
          Number.isFinite(top) &&
          Number.isFinite(bottom)
        ) {
          const topHasMinus =
            /^-/.test(toleranceLines[0].text);

          const bottomHasPlus =
            /^\+/.test(toleranceLines[1].text);

          if (topHasMinus && bottomHasPlus) {
            combinedText =
              `${primary.text} +${String(
                Number(bottom.toFixed(3))
              )}/-${String(Number(top.toFixed(3)))}`;
          } else {
            combinedText =
              `${primary.text} +${String(
                Number(top.toFixed(3))
              )}/-${String(
                Number(bottom.toFixed(3))
              )}`;
          }
        }
      }
    }

    // Append any other non-tolerance text in the same cluster (e.g. THRU ALL, ↧ 7, fits)
    // so they are included in the same balloon specification.
    const otherTextItems = sorted
      .slice(1)
      .filter((item) => !isToleranceLineText(item.text))
      .sort((a, b) => clusterCenterY(a) - clusterCenterY(b));
      
    if (otherTextItems.length > 0) {
      const otherText = otherTextItems
        .map(item => normalizeDetectionText(item.text))
        .join(' ');
      combinedText = `${combinedText} ${otherText}`;
    }

    result.push({
      ...primary,
      text: combinedText
    });
  }

  return result;
};

/* 100% zoom is the drawing's real printed size - 96 screen pixels
   per inch, which is what the operating system's own PDF viewer
   renders at 100%. Everything below that is a deliberate zoom-out,
   so the label always reports the true size of what you are seeing. */
const PHYSICAL_SCALE = 96 / 72;
const MIN_ZOOM = PHYSICAL_SCALE * 0.25;
const MAX_ZOOM = PHYSICAL_SCALE * 2;

/* Safety valve for large-format sheets: an A0 page rendered at the
   real printed size on a 2x display would ask for a quarter of a
   gigabyte of bitmap.  Past this area the scale is eased back so
   the browser never runs out of canvas. */
const MAX_CANVAS_PIXELS = 30000000;

export default function DrawingWorkspace() {
  const { id } = useParams();
  /* Exactly one backing-store pixel per screen pixel.  Rendering at
     max(devicePixelRatio, 2) forced the browser to downscale the
     canvas on 125% / 150% Windows displays, and that resample is
     what made every line and number look soft. */
  const dRatio = window.devicePixelRatio || 1;

  /* Balloons saved before this change were written as canvas pixels
     produced by the old max(devicePixelRatio, 2) backing store.
     Every conversion of those stored values keeps that ratio, or
     the markers would shift on 1x and 1.5x screens. */
  const legacyDRatio = Math.max(window.devicePixelRatio || 1, 2);

  const canvasRef = useRef(null);
  const pdfContainerRef = useRef(null);

  // Used for dragging balloons
  const dragBalloonRef = useRef(null);

  // Used for the manual "Add Dimension" drag-box selection
  const selectionRef = useRef(null);
  const [selection, setSelection] = useState(null);

  // Reused OCR worker + high-res page render cache (vector Ø inspection)
  const ocrWorkerRef = useRef(null);
  const ocrCacheRef = useRef(null);

  /*
    Second OCR worker running the Danish model, whose alphabet contains
    Ø natively - the English model has no such glyph, so it can only
    ever return a substitute for it. Created on first use; if the model
    is missing the read simply stays English-only.
  */
  const ocrDanWorkerRef = useRef(null);
  const ocrDanUnavailableRef = useRef(false);

  // Active main-canvas render task (cancelled before each re-render)
  const renderTaskRef = useRef(null);

  // Used for the Add Dimension drag-select
  const addSelectRef = useRef(null);

  const [project, setProject] = useState(null);
  const [drawings, setDrawings] = useState([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState(null);

  const [balloons, setBalloons] = useState([]);
  const [characteristics, setCharacteristics] = useState([]);

  const [mode, setMode] = useState('none');
  const [selectedBalloonId, setSelectedBalloonId] = useState(null);

  const [addScanning, setAddScanning] = useState(false);
  const [selectRect, setSelectRect] = useState(null);
  const [roiRect, setRoiRect] = useState(null);
  const [previewDetections, setPreviewDetections] = useState([]);
  const roiSelectRef = useRef(null);

  const [zoom, setZoom] = useState(PHYSICAL_SCALE);
  const [renderScale, setRenderScale] = useState(1);

  // Current on-screen size (CSS px) of the drawing canvas.
  // Balloon overlays are painted against this box.
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  // Container width + a tick bumped when the device pixel ratio
  // changes - both drive re-renders of the PDF canvas.
  const [containerW, setContainerW] = useState(0);
  const [renderTick, setRenderTick] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(1);

  const [pdfDocument, setPdfDocument] = useState(null);
  const [pdfPage, setPdfPage] = useState(null);

  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [loadingPdf, setLoadingPdf] = useState(false);

  const [activeDrawingMenuId, setActiveDrawingMenuId] = useState(null);
  const [confirmDeleteDrawingId, setConfirmDeleteDrawingId] =
    useState(null);

  const [drawingError, setDrawingError] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);

  /*
    Prevents Auto Detect from running twice on the same
    drawing. Reset by "Clear All Ballooning" or when the
    drawing / page changes.
  */

  const autoDetectDoneRef = useRef(false);

  const [savingUnitId, setSavingUnitId] = useState(null);
  const [savingCharacteristicId, setSavingCharacteristicId] = useState(null);
  const [showCharacteristicsTable, setShowCharacteristicsTable] = useState(false);

  // Editable right-panel balloon form
  const [currentBalloonNo, setCurrentBalloonNo] = useState('');
  const [editData, setEditData] = useState(null);
  const [focusedField, setFocusedField] = useState('specification');

  const insertSymbol = (sym) => {
    const activeEl = document.activeElement;
    const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
    const start = isInput && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
    const end = isInput && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;

    if (focusedField === 'currentBalloonNo') {
      setCurrentBalloonNo(prev => {
        const val = prev || '';
        if (start !== null) {
          setTimeout(() => activeEl.setSelectionRange(start + sym.length, start + sym.length), 0);
          return val.substring(0, start) + sym + val.substring(end);
        }
        return val + sym;
      });
      return;
    }
    if (!editData) return;
    setEditData((prev) => {
      if (!prev) return prev;
      const val = prev[focusedField] || '';
      let newVal = val + sym;
      if (start !== null) {
        newVal = val.substring(0, start) + sym + val.substring(end);
        setTimeout(() => activeEl.setSelectionRange(start + sym.length, start + sym.length), 0);
      }
      return { ...prev, [focusedField]: newVal };
    });
  };

  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

  const backendBase = apiBase.replace(/\/api\/?$/, '');

  /* =========================================================
     DRAWING URL
  ========================================================= */

  const drawingUrlFor = (drawingItem) => {
    if (!drawingItem) return null;

    let pathValue = drawingItem.url || drawingItem.filePath;

    if (!pathValue) return null;

    if (pathValue.startsWith('http')) {
      return pathValue;
    }

    if (!pathValue.startsWith('/')) {
      pathValue = `/${pathValue}`;
    }

    return `${backendBase}${pathValue}`;
  };

  /* =========================================================
     LOAD DATA
  ========================================================= */

  const loadData = async () => {
    try {
      const projectData = await api.get(`/projects/${id}`);
      setProject(projectData);

      const drawingsData = await api
        .get(`/projects/${id}/drawings`)
        .catch(async () => {
          const single = await api
            .get(`/projects/${id}/drawing`)
            .catch(() => null);

          return single ? [single] : [];
        });

      const normalizedDrawings = drawingsData.map((drawing) => ({
        ...drawing,
        url: drawing.filePath || drawing.url
      }));

      setDrawings(normalizedDrawings);

      setSelectedDrawingId((current) => {
        if (
          current &&
          normalizedDrawings.some(
            (item) => item._id === current
          )
        ) {
          return current;
        }

        return normalizedDrawings.length > 0
          ? normalizedDrawings[0]._id
          : null;
      });

      const balloonData = await api
        .get(`/projects/${id}/balloons`)
        .catch(() => []);

      setBalloons(balloonData);

      const characteristicData = await api
        .get(`/projects/${id}/characteristics`)
        .catch(() => []);

      setCharacteristics(characteristicData);
    } catch (error) {
      console.error(error);
      setMessage('Unable to load project');
    }
  };

  useEffect(() => {
    loadData();
  }, [id]);

  /* =========================================================
     SELECTED DRAWING
  ========================================================= */

  const selectedDrawing = useMemo(
    () =>
      drawings.find(
        (drawingItem) =>
          drawingItem._id === selectedDrawingId
      ) || null,
    [drawings, selectedDrawingId]
  );

  const drawingUrl = drawingUrlFor(selectedDrawing);

  const isPdf =
    selectedDrawing?.filePath
      ?.toLowerCase()
      .endsWith('.pdf') ||
    selectedDrawing?.url
      ?.toLowerCase()
      .endsWith('.pdf') ||
    selectedDrawing?.fileName
      ?.toLowerCase()
      .endsWith('.pdf');

  /* =========================================================
     COORDINATE HELPERS
     ---------------------------------------------------------
     Balloon positions are saved as fractions of the rendered
     page (0..1). Canvas pixels are only used while a gesture
     is in progress, because pixels change with zoom.
  ========================================================= */

  const canvasMetrics = () => {
    const canvas = canvasRef.current;

    if (!canvas || !canvas.width || !canvas.height) {
      return null;
    }

    return { w: canvas.width, h: canvas.height };
  };

  /* The canvas size as legacy pixel coordinates were recorded
     against - before the backing store was tied to the exact
     device pixel ratio. */
  const legacyMetrics = () =>
    viewSize.w > 0 && viewSize.h > 0
      ? {
          w: viewSize.w * legacyDRatio,
          h: viewSize.h * legacyDRatio
        }
      : null;

  /* Zoom that fits the current page inside the viewer panel. */
  const fitZoom = () => {
    if (!pdfPage) return PHYSICAL_SCALE;

    const base = pdfPage.getViewport({ scale: 1 });
    const containerWidth =
      containerW ||
      pdfContainerRef.current?.clientWidth ||
      900;

    return Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, (containerWidth - 40) / base.width)
    );
  };

  /* =========================================================
     DISPLAY BALLOONS
  ========================================================= */

  const displayedBalloons = useMemo(() => {
    const allBallons = new Map();
    const firstDrawingId = drawings.length > 0 ? drawings[0]._id : null;

    const deviceSize = legacyMetrics();

    const legacyRelX = (px) =>
      deviceSize && px != null ? Number(px) / deviceSize.w : null;

    const legacyRelY = (py) =>
      deviceSize && py != null ? Number(py) / deviceSize.h : null;

    // Resolves a stored/legacy anchor into page-relative space.
    const resolveAnchorRel = (relX, relY, anchorRelX, anchorRelY, anchorX, anchorY) => {
      if (anchorRelX != null && anchorRelY != null) {
        return { anchorXRel: anchorRelX, anchorYRel: anchorRelY };
      }

      const hasPixelAnchor =
        (anchorX != null || anchorY != null) &&
        (Number(anchorX) !== 0 || Number(anchorY) !== 0);

      if (hasPixelAnchor && deviceSize) {
        return {
          anchorXRel: Number(anchorX) / deviceSize.w,
          anchorYRel: Number(anchorY) / deviceSize.h
        };
      }

      return { anchorXRel: null, anchorYRel: null };
    };

    // Add balloons from balloons state
    (balloons || []).forEach((b) => {
      const belongsTo = b.drawingId || firstDrawingId;
      if (belongsTo && belongsTo !== selectedDrawingId) return;

      const xRel = b.xRel ?? legacyRelX(b.x);
      const yRel = b.yRel ?? legacyRelY(b.y);
      const anchor = resolveAnchorRel(
        xRel,
        yRel,
        b.anchorXRel,
        b.anchorYRel,
        b.anchorX,
        b.anchorY
      );

      allBallons.set(b._id, {
        _id: b._id,
        number: b.number,
        x: b.x,
        y: b.y,
        xRel,
        yRel,
        anchorX: b.anchorX ?? (b.x || 0) + 25,
        anchorY: b.anchorY ?? (b.y || 0) + 25,
        anchorXRel: anchor.anchorXRel,
        anchorYRel: anchor.anchorYRel,
        text: b.text,
        type: b.type,
        page: b.page,
        status: b.status || 'Draft'
      });
    });

    // Add/override with characteristics (auto-detect etc.)
    (characteristics || []).forEach((c) => {
      const belongsTo = c.drawingId || firstDrawingId;
      if (belongsTo && belongsTo !== selectedDrawingId) return;

      if (c.balloonId) {
        const existing = allBallons.get(c.balloonId);

        const xRel = existing?.xRel ?? c.xRel ?? legacyRelX(existing?.x ?? c.x);
        const yRel = existing?.yRel ?? c.yRel ?? legacyRelY(existing?.y ?? c.y);
        const anchor = resolveAnchorRel(
          xRel,
          yRel,
          existing?.anchorXRel,
          existing?.anchorYRel,
          existing?.anchorX,
          existing?.anchorY
        );

        allBallons.set(c.balloonId, {
          _id: c.balloonId,
          number: c.number,
          x: existing?.x ?? c.x,
          y: existing?.y ?? c.y,
          xRel,
          yRel,
          anchorX: existing?.anchorX ?? c.anchorX ?? (c.x || 0) + 25,
          anchorY: existing?.anchorY ?? c.anchorY ?? (c.y || 0) + 25,
          anchorXRel: anchor.anchorXRel,
          anchorYRel: anchor.anchorYRel,
          text: normalizeCallout(c)?.specification ?? c.specification,
          type: c.type,
          page: c.page,
          status: c.status || 'Draft'
        });
      }
    });

    return Array.from(allBallons.values());
  }, [balloons, characteristics, selectedDrawingId, drawings, viewSize]);

  /* =========================================================
     LOAD PDF
  ========================================================= */

  useEffect(() => {
    if (
      !selectedDrawing ||
      !drawingUrl ||
      !isPdf
    ) {
      setPdfDocument(null);
      setPdfPage(null);
      setPageNumber(1);
      setPageCount(1);
      autoDetectDoneRef.current = false;
      setRoiRect(null);
      return;
    }

    let cancelled = false;

    const loadPdf = async () => {
      try {
        setLoadingPdf(true);
        setDrawingError(false);

        const loadingTask = pdfjsLib.getDocument({
          url: drawingUrl
        });

        const pdf = await loadingTask.promise;

        if (cancelled) return;

        setPdfDocument(pdf);
        setPageCount(pdf.numPages);
        setPageNumber(1);

        const page = await pdf.getPage(1);

        if (!cancelled) {
          setPdfPage(page);
          autoDetectDoneRef.current = false;
          setRoiRect(null);
        }
      } catch (error) {
        console.error(
          'PDF loading error:',
          error
        );

        if (!cancelled) {
          setDrawingError(true);
          setMessage(
            'Unable to display this PDF. Make sure the backend is running.'
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingPdf(false);
        }
      }
    };

    loadPdf();

    return () => {
      cancelled = true;
    };
  }, [
    selectedDrawingId,
    drawingUrl,
    isPdf
  ]);

  /* =========================================================
     LOAD SELECTED PAGE
  ========================================================= */

  useEffect(() => {
    if (!pdfDocument) return;

    let cancelled = false;

    const loadPage = async () => {
      try {
        setLoadingPdf(true);

        const page =
          await pdfDocument.getPage(
            pageNumber
          );

        if (!cancelled) {
          setPdfPage(page);
          autoDetectDoneRef.current = false;
          setRoiRect(null);
        }
      } catch (error) {
        console.error(error);
      } finally {
        if (!cancelled) {
          setLoadingPdf(false);
        }
      }
    };

    loadPage();

    return () => {
      cancelled = true;
    };
  }, [pdfDocument, pageNumber]);

  /* =========================================================
     RENDER PDF
  ========================================================= */

  useEffect(() => {
    if (
      !pdfPage ||
      !canvasRef.current
    ) {
      return;
    }

    const canvas = canvasRef.current;
    const context =
      canvas.getContext('2d');

    /*
      The viewer opens at the drawing's real printed size, so the
      rasterisation is identical to the original file.  Anything
      smaller shrinks the dimension text below the resolution the
      drawing was authored at - the container scrolls instead.
    */
    const finalScale = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, zoom)
    );

    const baseViewport =
      pdfPage.getViewport({ scale: 1 });

    let rasterScale = finalScale * dRatio;

    const area =
      rasterScale * baseViewport.width *
      rasterScale * baseViewport.height;

    if (area > MAX_CANVAS_PIXELS) {
      rasterScale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
    }

    /*
      Integer backing store, and a CSS size derived FROM it, so the
      canvas covers exactly backingWidth device pixels at any
      display density.  Letting a fractional viewport width fall
      through the canvas' integer truncation leaves the element a
      pixel out of register with its own bitmap - a second, quieter
      way for the drawing to come out soft.
    */
    const backingWidth = Math.max(
      1,
      Math.round(rasterScale * baseViewport.width)
    );

    const backingHeight = Math.max(
      1,
      Math.round(
        backingWidth * (baseViewport.height / baseViewport.width)
      )
    );

    const viewport =
      pdfPage.getViewport({
        scale: backingWidth / baseViewport.width
      });

    canvas.width = backingWidth;
    canvas.height = backingHeight;

    canvas.style.width =
      `${backingWidth / dRatio}px`;

    canvas.style.height =
      `${backingHeight / dRatio}px`;

    setViewSize({
      w: backingWidth / dRatio,
      h: backingHeight / dRatio
    });

    const renderContext = {
      canvasContext: context,
      viewport
    };

    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel();
      } catch (error) {
        /* previous task already finished */
      }
    }

    const renderTask = pdfPage.render(renderContext);
    renderTaskRef.current = renderTask;
    renderTask.promise.catch(() => {});
  }, [pdfPage, zoom, loadingPdf, renderTick]);

  /* Track the viewer panel width (used by the Fit button) and watch
     the device pixel ratio (monitor switch, browser / OS zoom) so
     the canvas is always rasterised at the current pixel density. */
  useEffect(() => {
    const el = pdfContainerRef.current;
    if (!el) return;

    const onResize = () => {
      const w = Math.round(el.clientWidth);
      setContainerW((prev) => (prev === w ? prev : w));
    };

    onResize();

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(onResize)
        : null;
    if (ro) ro.observe(el);

    let mql = null;
    const watchDpr = () => {
      if (mql && mql.removeEventListener) {
        mql.removeEventListener('change', onDprChange);
      }
      mql = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`
      );
      if (mql.addEventListener) {
        mql.addEventListener('change', onDprChange);
      }
    };
    function onDprChange() {
      setRenderTick((t) => t + 1);
      watchDpr();
    }
    watchDpr();

    return () => {
      if (ro) ro.disconnect();
      if (mql && mql.removeEventListener) {
        mql.removeEventListener('change', onDprChange);
      }
    };
  }, []);

  /* =========================================================
     NORMALIZE LEGACY COORDINATES
     ---------------------------------------------------------
     Older balloons stored raw canvas pixels, which drift
     away from their dimension as soon as the zoom changes.
     Convert them once to page-relative fractions (and save
     them) so every existing balloon behaves like a new one.
  ========================================================= */

  useEffect(() => {
    if (!viewSize.w || !viewSize.h) {
      return;
    }

    const metrics = legacyMetrics();

    if (!metrics) {
      return;
    }

    const legacyBalloons = (balloons || []).filter(
      (item) => item.xRel == null
    );

    const legacyCharacteristics = (characteristics || []).filter(
      (item) => item.xRel == null
    );

    if (
      legacyBalloons.length === 0 &&
      legacyCharacteristics.length === 0
    ) {
      return;
    }

    const toRelative = (item) => ({
      xRel: clamp01((item.x ?? 0) / metrics.w),
      yRel: clamp01((item.y ?? 0) / metrics.h)
    });

    const toRelativeAnchor = (item) => {
      const hasPixelAnchor =
        (item.anchorX != null || item.anchorY != null) &&
        (Number(item.anchorX) !== 0 ||
          Number(item.anchorY) !== 0);

      if (!hasPixelAnchor) {
        return { anchorXRel: null, anchorYRel: null };
      }

      return {
        anchorXRel: clamp01(item.anchorX / metrics.w),
        anchorYRel: clamp01(item.anchorY / metrics.h)
      };
    };

    setBalloons((prev) =>
      prev.map((item) => {
        if (item.xRel != null) return item;

        return {
          ...item,
          ...toRelative(item),
          ...toRelativeAnchor(item)
        };
      })
    );

    setCharacteristics((prev) =>
      prev.map((item) =>
        item.xRel != null
          ? item
          : { ...item, ...toRelative(item) }
      )
    );

    // Persist so the conversion only ever runs once.
    legacyBalloons.forEach(async (item) => {
      try {
        await api.put(`/balloons/${item._id}`, {
          ...toRelative(item),
          ...toRelativeAnchor(item)
        });
      } catch (error) {
        console.error(
          'Failed to migrate balloon coordinates:',
          error
        );
      }
    });

    legacyCharacteristics.forEach(async (item) => {
      try {
        await api.put(`/characteristics/${item._id}`, toRelative(item));
      } catch (error) {
        console.error(
          'Failed to migrate characteristic coordinates:',
          error
        );
      }
    });
  }, [viewSize, balloons, characteristics]);

/* =========================================================
      DOWNLOAD PDF WITH BALLOONS
  ========================================================= */

  const downloadPdf = async () => {
    if (!selectedDrawing) {
      setMessage('No drawing selected');
      return;
    }

    // Check if we have a PDF file path/url
    const isPdf = selectedDrawing.filePath
      ? selectedDrawing.filePath.toLowerCase().endsWith('.pdf')
      : selectedDrawing.url
        ? selectedDrawing.url.toLowerCase().endsWith('.pdf')
        : false;

    if (!isPdf) {
      setMessage('Selected drawing is not a PDF');
      return;
    }

    if (!pdfPage) {
      setMessage('PDF not loaded - please wait for the drawing to render');
      return;
    }

    try {
      setMessage('Generating PDF with balloons...');

      // Original page size in PDF points (1pt = 1/72 inch)
      const baseViewport = pdfPage.getViewport({ scale: 1 });

      // The balloon x/y values live in the displayed canvas pixel space.
      // Re-map them onto the high-resolution export canvas below.
      let displayScale = 1;

      if (canvasRef.current) {
        displayScale =
          canvasRef.current.width /
          baseViewport.width;
      }

      // Render the page at high resolution so the downloaded
      // PDF stays sharp regardless of the current zoom level.
      const exportScale = 3;
      const viewport =
        pdfPage.getViewport({
          scale: exportScale
        });

      const exportCanvas =
        document.createElement('canvas');

      exportCanvas.width =
        Math.ceil(viewport.width);

      exportCanvas.height =
        Math.ceil(viewport.height);

      const context =
        exportCanvas.getContext('2d');

      context.fillStyle = '#ffffff';
      context.fillRect(
        0,
        0,
        exportCanvas.width,
        exportCanvas.height
      );

      await pdfPage.render({
        canvasContext: context,
        viewport
      }).promise;

      const ratio =
        exportScale / displayScale;

      const pageBalloons =
        displayedBalloons.filter(
          (balloon) =>
            !balloon.page ||
            balloon.page === pageNumber
        );

      context.lineCap = 'round';
      context.lineJoin = 'round';

      for (const balloon of pageBalloons) {
        // Balloon positions are page-relative fractions, so they
        // land on the same spot on the exported page no matter
        // what zoom level the drawing was at.
        const canvasW = canvasRef.current?.width || 1;
        const canvasH = canvasRef.current?.height || 1;

        const rx =
          balloon.xRel ?? (balloon.x ?? 0) / canvasW;

        const ry =
          balloon.yRel ?? (balloon.y ?? 0) / canvasH;

        const arx =
          balloon.anchorXRel ?? rx + 25 / canvasW;

        const ary =
          balloon.anchorYRel ?? ry + 25 / canvasH;

        const x = rx * viewport.width;
        const y = ry * viewport.height;
        const ax = arx * viewport.width;
        const ay = ary * viewport.height;

        // Direction from the balloon TOWARDS the value
        const dx = ax - x;
        const dy = ay - y;

        const dist =
          Math.hypot(dx, dy) || 1;

        const ux = dx / dist;
        const uy = dy / dist;

        // Balloon marker radius (matches the 24px on-screen circle)
        const radius = 9 * ratio;
        const head = 7 * ratio;

        const startX =
          x + ux * radius;

        const startY =
          y + uy * radius;

        // Leader line
        context.strokeStyle = 'rgba(127, 29, 29, 0.7)';
        context.lineWidth = Math.max(
          1.5 * ratio,
          1.5
        );

        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(ax, ay);
        context.stroke();

        // Arrowhead pointing at the measurement
        const angle =
          Math.atan2(uy, ux);

        context.fillStyle = 'rgba(127, 29, 29, 0.7)';
        context.beginPath();
        context.moveTo(ax, ay);
        context.lineTo(
          ax -
            head *
              Math.cos(angle - 0.35),
          ay -
            head *
              Math.sin(angle - 0.35)
        );
        context.lineTo(
          ax -
            head *
              Math.cos(angle + 0.35),
          ay -
            head *
              Math.sin(angle + 0.35)
        );
        context.closePath();
        context.fill();

        // Balloon circle
        context.fillStyle = 'rgba(127, 29, 29, 0.6)';
        context.strokeStyle = '#ef4444';
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(
          x,
          y,
          radius,
          0,
          Math.PI * 2
        );
        context.fill();

        // Balloon number
        context.fillStyle = '#7f1d1d';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = `bold ${Math.max(
          10 * ratio,
          10
        )}px sans-serif`;

        context.fillText(
          String(
            balloon.number ?? ''
          ),
          x,
          y
        );
      }

      // Build a real PDF sized to the original drawing page
      const pageWidthMm =
        (baseViewport.width * 25.4) / 72;

      const pageHeightMm =
        (baseViewport.height * 25.4) / 72;

      const pdf = new jsPDF({
        orientation:
          pageWidthMm >= pageHeightMm
            ? 'landscape'
            : 'portrait',
        unit: 'mm',
        format: [
          pageWidthMm,
          pageHeightMm
        ]
      });

      const imageData =
        exportCanvas.toDataURL(
          'image/png'
        );

      pdf.addImage(
        imageData,
        'PNG',
        0,
        0,
        pageWidthMm,
        pageHeightMm
      );

      // Add declaration
      pdf.setFontSize(11);
      pdf.setFont('times', 'normal');
      pdf.setTextColor(0, 0, 0); // Black text
      pdf.setFillColor(255, 255, 255);
      pdf.rect(pageWidthMm - 100, pageHeightMm - 9, 95, 6, 'F');
      pdf.text('Ballooning generated using PESCOM VYAVASTHA software', pageWidthMm - 10, pageHeightMm - 5, { align: 'right' });
      pdf.setTextColor(0, 0, 0); // Reset to black


      // Add Characteristics Table as new page
      pdf.addPage('a4', 'portrait');
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Characteristics Table', 14, 20);

      // Sort characteristics by balloon number
      const sortedCharacteristics = [...characteristics].sort(
        (a, b) => (a.number || 0) - (b.number || 0)
      );

      const tableData = sortedCharacteristics.map((char) => {
        const d = getDisplayValues(char);
        return [
          String(char.number || ''),
          String(d.specification || ''),
          String(d.mainVal || ''),
          String(d.plusTol || ''),
          String(d.minusTol || '')
        ];
      });

      autoTable(pdf, {
        startY: 25,
        head: [['Balloon No', 'Description', 'Dimensions No', 'Upper Tolerance', 'Lower Tolerance']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: [41, 128, 185], textColor: [255, 255, 255], fontStyle: 'bold' },
        styles: { fontSize: 10, cellPadding: 3, halign: 'left' },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        margin: { top: 20, right: 14, bottom: 20, left: 14 }
      });

      const downloadName = selectedDrawing.fileName
        ? selectedDrawing.fileName.replace(
            /\.[^/.]+$/,
            '_ballooned.pdf'
          )
        : 'ballooned_drawing.pdf';

      pdf.save(downloadName);

      setMessage(
        'PDF with balloons downloaded successfully'
      );
    } catch (error) {
      console.error(
        'PDF download error:',
        error
      );

      setMessage(
        error.message ||
        'Failed to download PDF with balloons'
      );
    }
  };

  /* =========================================================
     ADD DIMENSION
     Works like the Lens "Add Dimension" tool:
     - Toggle with the button or press "A"
     - Click, or drag a box over a dimension on the drawing
     - The AI reads the dimension value (PDF text layer, with
       OCR fallback) and adds a new balloon
     - The Dimension Editor opens so the value can be verified
  ========================================================= */

  const getNextBalloonNumber = () => {
    let currentMaxNumber = 0;

    displayedBalloons.forEach((balloon) => {
      const number = Number(balloon.number);

      if (
        Number.isFinite(number) &&
        number > currentMaxNumber
      ) {
        currentMaxNumber = number;
      }
    });

    return currentMaxNumber + 1;
  };

  const addDimensionAtRect = async (rect) => {
    if (!pdfPage || !canvasRef.current) {
      return;
    }

    try {
      setAddScanning(true);

      const centerX = (rect.x1 + rect.x2) / 2;
      const centerY = (rect.y1 + rect.y2) / 2;

      /*
        Use the unified dimension reading pipeline - handing it the
        dragged box so the value inside that box is the one read
        (horizontal or vertical) instead of whatever sits nearest the
        centre point.
      */
      const detected = await readDimensionAtPoint(centerX, centerY, {
        rect
      });

      /*
        Always place a balloon wherever the user drags.
        If no dimension text could be read, leave the value blank so the
        side panel prompts for the real number rather than showing a
        placeholder word as if it were the drawing's text.
      */

      const fallbackDetected = detected || {
        text: '',
        value: '',
        type: 'Dimension',
        plusTolerance: '0.00',
        minusTolerance: '0.00',
        upperLimit: '0.00',
        lowerLimit: '0.00',
        specification: '',
        centerX,
        centerY
      };

      /*
        The balloon must stay where the user marked. Snap the leader
        onto the detected text only when it agrees with the selection:
        inside the dragged box (a wide box puts the centre far from the
        value) or close to it for a plain point read.
      */
      let anchorX = centerX;
      let anchorY = centerY;

      const detectedAnchorX = Number(fallbackDetected.centerX);
      const detectedAnchorY = Number(fallbackDetected.centerY);

      const snapPad = 25 * dRatio;
      const snapLeft = Math.min(rect.x1, rect.x2) - snapPad;
      const snapRight = Math.max(rect.x1, rect.x2) + snapPad;
      const snapTop = Math.min(rect.y1, rect.y2) - snapPad;
      const snapBottom = Math.max(rect.y1, rect.y2) + snapPad;

      const detectedInsideSelection =
        Number.isFinite(detectedAnchorX) &&
        Number.isFinite(detectedAnchorY) &&
        detectedAnchorX >= snapLeft &&
        detectedAnchorX <= snapRight &&
        detectedAnchorY >= snapTop &&
        detectedAnchorY <= snapBottom;

      if (
        detectedInsideSelection ||
        (Number.isFinite(detectedAnchorX) &&
          Number.isFinite(detectedAnchorY) &&
          Math.hypot(detectedAnchorX - centerX, detectedAnchorY - centerY) <=
            45 * dRatio)
      ) {
        anchorX = detectedAnchorX;
        anchorY = detectedAnchorY;
      }

      const balloonX = Math.max(0, anchorX + 25);
      const balloonY = Math.max(0, anchorY - 25);

      const nextNumber = getNextBalloonNumber();

      const status = statusForDetection(fallbackDetected);

      /* Page-relative positions keep the balloon glued to the
         dimension even after the drawing is zoomed. */
      const metrics = canvasMetrics();

      const xRel = metrics ? clamp01(balloonX / metrics.w) : null;
      const yRel = metrics ? clamp01(balloonY / metrics.h) : null;
      const anchorXRel = metrics ? clamp01(anchorX / metrics.w) : null;
      const anchorYRel = metrics ? clamp01(anchorY / metrics.h) : null;

      const balloon = await api.post(
        `/projects/${id}/balloons`,
        {
          drawingId: selectedDrawingId,
          x: balloonX,
          y: balloonY,
          anchorX,
          anchorY,
          xRel,
          yRel,
          anchorXRel,
          anchorYRel,
          text: fallbackDetected.text,
          type: fallbackDetected.type,
          number: nextNumber,
          page: pageNumber,
          status
        }
      );

      const characteristic = await api.post(
        `/projects/${id}/characteristics`,
        {
          drawingId: selectedDrawingId,
          balloonId: balloon._id,
          number: nextNumber,
          type: fallbackDetected.type,
          value: fallbackDetected.value,
          unit:
            fallbackDetected.type === 'Angle' ? 'deg' : 'mm',
          plusTolerance: fallbackDetected.plusTolerance,
          minusTolerance: fallbackDetected.minusTolerance,
          upperLimit: fallbackDetected.upperLimit ?? '0.00',
          lowerLimit: fallbackDetected.lowerLimit ?? '0.00',
          specification: fallbackDetected.specification,
          inspectionMethod: 'Vernier Caliper',
          instrument: '',
          actualValue: '',
          result: 'NOT INSPECTED',
          remarks: '',
          page: pageNumber,
          x: anchorX,
          y: anchorY,
          xRel: anchorXRel,
          yRel: anchorYRel,
          status
        }
      );

      setBalloons((prev) => [
        ...prev,
        {
          ...balloon,
          number: nextNumber,
          x: balloonX,
          y: balloonY,
          xRel,
          yRel,
          anchorXRel,
          anchorYRel,
          page: pageNumber,
          drawingId: selectedDrawingId
        }
      ]);

      setCharacteristics((prev) => [
        ...prev,
        {
          ...characteristic,
          number: nextNumber,
          xRel: anchorXRel,
          yRel: anchorYRel,
          page: pageNumber,
          drawingId: selectedDrawingId
        }
      ]);

      // Opens the Dimension Editor so the value can be verified
      setSelectedBalloonId(balloon._id);

      setMessage(
        detected
          ? detected.needsVerification
            ? `Balloon ${nextNumber}: read "${fallbackDetected.specification}" - check this value in the side panel.`
            : `Balloon ${nextNumber}: "${fallbackDetected.specification}" read from the drawing`
          : `Balloon ${nextNumber} added at that spot. Fill in its value in the side panel.`
      );
    } catch (error) {
      console.error(
        'Add dimension failed:',
        error
      );

      setMessage(
        error.message ||
        'Unable to add dimension'
      );
    } finally {
      setAddScanning(false);
    }
  };

  /* Drag-select over a dimension. */

  const clientToCanvasPoint = (event) => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return { x: 0, y: 0 };
    }

    const rect = canvas.getBoundingClientRect();

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  };

  /*
    The ROI (yellow) box is stored in page-relative fractions - the
    same convention balloon positions use - so it stays pinned to the
    same part of the drawing when the canvas is resized for zoom.
    Storing absolute device pixels made the box drift (and the
    auto-detect filter apply to the wrong region) on every zoom.
  */
  const roiPointToRelative = (point) => {
    const metrics = canvasMetrics();

    if (!metrics) {
      return { x: point.x, y: point.y };
    }

    return {
      x: point.x / metrics.w,
      y: point.y / metrics.h
    };
  };

  const roiRectToCanvas = (rect) => {
    if (!rect) {
      return null;
    }

    const metrics = canvasMetrics();

    if (!metrics) {
      return rect;
    }

    return {
      x1: rect.x1 * metrics.w,
      y1: rect.y1 * metrics.h,
      x2: rect.x2 * metrics.w,
      y2: rect.y2 * metrics.h
    };
  };

  const handleAddPointerDown = (event) => {
    if (!canvasRef.current) return;
    if (event.target.closest('.balloon-marker')) return;

    if (mode === 'manual') {
      const point = clientToCanvasPoint(event);
      addSelectRef.current = { startX: point.x, startY: point.y };
      setSelectRect({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } else if (mode === 'select_area') {
      const rp = roiPointToRelative(clientToCanvasPoint(event));
      roiSelectRef.current = { startX: rp.x, startY: rp.y };
      setRoiRect({ x1: rp.x, y1: rp.y, x2: rp.x, y2: rp.y });
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  };

  const handleAddPointerMove = (event) => {
    if (!canvasRef.current) return;
    if (mode === 'manual' && addSelectRef.current) {
      const point = clientToCanvasPoint(event);
      const start = addSelectRef.current;
      setSelectRect({
        x1: Math.min(start.startX, point.x),
        y1: Math.min(start.startY, point.y),
        x2: Math.max(start.startX, point.x),
        y2: Math.max(start.startY, point.y)
      });
    } else if (mode === 'select_area' && roiSelectRef.current) {
      const rp = roiPointToRelative(clientToCanvasPoint(event));
      const start = roiSelectRef.current;
      setRoiRect({
        x1: Math.min(start.startX, rp.x),
        y1: Math.min(start.startY, rp.y),
        x2: Math.max(start.startX, rp.x),
        y2: Math.max(start.startY, rp.y)
      });
    }
  };

  const handleAddPointerUp = async (event) => {
    if (!canvasRef.current) return;
    if (mode === 'manual' && addSelectRef.current) {
      const start = addSelectRef.current;
      addSelectRef.current = null;
      const point = clientToCanvasPoint(event);
      let rect = {
        x1: Math.min(start.startX, point.x),
        y1: Math.min(start.startY, point.y),
        x2: Math.max(start.startX, point.x),
        y2: Math.max(start.startY, point.y)
      };
      setSelectRect(null);
      const width = rect.x2 - rect.x1;
      const height = rect.y2 - rect.y1;
      if (width < 5 * dRatio && height < 5 * dRatio) {
        const cx = (rect.x1 + rect.x2) / 2;
        const cy = (rect.y1 + rect.y2) / 2;
        const half = 25 * dRatio;
        rect = { x1: cx - half, y1: cy - half, x2: cx + half, y2: cy + half };
      }
      await addDimensionAtRect(rect);
    } else if (mode === 'select_area' && roiSelectRef.current) {
      roiSelectRef.current = null;

      /*
        A click that never dragged would leave a zero-sized box,
        which would filter every detection out of Auto Detect.
        Treat it as "no area selected".
      */
      const roi = roiRectToCanvas(roiRect);

      if (
        !roi ||
        Math.abs(roi.x2 - roi.x1) < 5 * dRatio ||
        Math.abs(roi.y2 - roi.y1) < 5 * dRatio
      ) {
        setRoiRect(null);
      }

      setMode('none');
    }
  };
  /* =========================================================
     DELETE SINGLE BALLOON
  ========================================================= */

  const deleteBalloon = async (
    balloonId
  ) => {
    if (!balloonId) {
      setMessage(
        'Select a balloon first'
      );
      return;
    }

    try {
      await api.delete(
        `/balloons/${balloonId}`
      );

      // Renumber the remaining balloons sequentially (1, 2, 3, ...),
      // so deleting a balloon shifts every following one down by one.
      const remaining = balloons
        .filter(
          (item) =>
            item._id !== balloonId
        )
        .sort(
          (a, b) =>
            (a.number ?? 0) -
            (b.number ?? 0)
        );

      const numberByBalloonId = {};

      remaining.forEach(
        (balloon, index) => {
          numberByBalloonId[
            balloon._id
          ] = index + 1;
        }
      );

      for (
        let index = 0;
        index < remaining.length;
        index += 1
      ) {
        const balloon =
          remaining[index];
        const newNumber =
          index + 1;

        if (
          balloon.number ===
          newNumber
        ) {
          continue;
        }

        try {
          await api.put(
            `/balloons/${balloon._id}`,
            { number: newNumber }
          );
        } catch (error) {
          console.error(
            'Failed to renumber balloon',
            balloon._id,
            error
          );
        }

        const characteristic =
          characteristics.find(
            (item) =>
              item.balloonId ===
              balloon._id
          );

        if (characteristic) {
          try {
            await api.put(
              `/characteristics/${characteristic._id}`,
              { number: newNumber }
            );
          } catch (error) {
            console.error(
              'Failed to renumber characteristic',
              characteristic._id,
              error
            );
          }
        }
      }

      setBalloons((prev) =>
        prev
          .filter(
            (item) =>
              item._id !== balloonId
          )
          .map((item) => ({
            ...item,
            number:
              numberByBalloonId[
                item._id
              ] ?? item.number
          }))
      );

      setCharacteristics((prev) =>
        prev
          .filter(
            (item) =>
              item.balloonId !==
              balloonId
          )
          .map((item) => ({
            ...item,
            number:
              numberByBalloonId[
                item.balloonId
              ] ?? item.number
          }))
      );

      setSelectedBalloonId(null);
      setEditData(null);
      setCurrentBalloonNo('');

      setMessage(
        'Balloon removed and balloons renumbered'
      );
    } catch (error) {
      setMessage(
        error.message ||
        'Failed to remove balloon'
      );
    }
  };

  /* =========================================================
     CLEAR ALL BALLOONING
  ========================================================= */

  const clearAllBallooning = async () => {
    if (
      balloons.length === 0 &&
      characteristics.length === 0
    ) {
      setMessage(
        'There are no balloons to clear'
      );
      return;
    }

    const confirmed =
      window.confirm(
        'Are you sure you want to clear ALL ballooning? This will remove all balloons and characteristics from this project.'
      );

    if (!confirmed) {
      return;
    }

    try {
      setMessage(
        'Clearing all ballooning...'
      );

      /*
        Delete every balloon.

        Your existing backend already has:
        DELETE /balloons/:balloonId
      */

      const uniqueBalloonIds = [
        ...new Set(
          balloons
            .map((item) => item._id)
            .filter(Boolean)
        )
      ];

      for (
        const balloonId of
        uniqueBalloonIds
      ) {
        try {
          await api.delete(
            `/balloons/${balloonId}`
          );
        } catch (error) {
          console.error(
            `Failed to delete balloon ${balloonId}`,
            error
          );
        }
      }

      /*
        Clear frontend state.
      */

      setBalloons([]);
      setCharacteristics([]);
      setSelectedBalloonId(null);
      autoDetectDoneRef.current = false;
      setRoiRect(null);

      setMessage(
        'All ballooning has been cleared'
      );
    } catch (error) {
      console.error(error);

      setMessage(
        error.message ||
        'Failed to clear ballooning'
      );
    }
  };

  /* =========================================================
     UPDATE UNIT
  ========================================================= */

  const updateUnit = async (
    characteristicId,
    newUnit
  ) => {
    const unit =
      newUnit.trim();

    if (!unit) {
      setMessage(
        'Please enter a unit'
      );
      return;
    }

    try {
      setSavingUnitId(
        characteristicId
      );

      /*
        Immediately update screen.
      */

      setCharacteristics((prev) =>
        prev.map((item) =>
          item._id ===
            characteristicId
            ? {
              ...item,
              unit
            }
            : item
        )
      );

      /*
        Save to backend.
      */

      const updated =
        await api.put(
          `/characteristics/${characteristicId}`,
          {
            unit
          }
        );

      /*
        If backend returns updated
        characteristic, use it.
      */

      if (updated) {
        setCharacteristics((prev) =>
          prev.map((item) =>
            item._id ===
              characteristicId
              ? {
                ...item,
                ...updated
              }
              : item
          )
        );
      }

      setMessage(
        `Unit changed to "${unit}"`
      );
    } catch (error) {
      console.error(error);

      setMessage(
        error.message ||
        'Failed to save unit'
      );

      /*
        Reload data in case backend
        rejected the update.
      */

      loadData();
    } finally {
      setSavingUnitId(null);
    }
  };

  /* =========================================================
     BALLOON EDIT PANEL (right side)
  ========================================================= */


  /*
   * parseSpecificationText
   * Parses a free-text engineering dimension string entered manually
   * in the Description field (e.g. "Ø10.10 +0.10/-0.10" or "9.1")
   * and returns { mainValue, plusTol, minusTol }
   *
   * Supported formats:
   *   Ø10.10 +0.10/-0.10
   *   10.05 +0.02 / -0.01
   *   14 +0.017/0
   *   2.75 ±0.10
   *   R25.00
   *   9.1 (no tolerance)
   *   Ø6.50 0 / -0.10
   */
    const parseSpecificationText = (text) => {
    if (!text) return null;
    const t = text.trim();

    // Strip common engineering prefixes / symbols at the front
    // to get the leading value text
    // Matches optional Ø/R/M/S prefix chars then the numeric part
    const mainRe = /^((?:Ø|∅|R|SR|SØ|M)?\s*(?:\d+\s*[xX×]\s*)?\d+(?:[.,]\d+)?(?:\s*(?:TYP|THRU|DP|DEEP|MAX|MIN|REF|mm|in|inch))?)/i;
    const mainMatch = t.match(mainRe);
    if (!mainMatch) return null;

    const mainValue = mainMatch[1].replace(',', '.').trim();
    const rest = t.slice(mainMatch[0].length).trim();

    if (!rest) {
      return { mainValue, plusTol: '', minusTol: '' };
    }

    let plusTol = '';
    let minusTol = '';

    // Helper: normalise a tolerance string to always have a sign prefix
    const withSign = (raw) => {
      const s = raw.replace(/\s+/g, '').replace(',', '.');
      if (s.startsWith('+') || s.startsWith('-')) return s;
      const num = parseFloat(s);
      return (num >= 0 ? '+' : '') + s;
    };

    // ─── Case 1: ± or +/- or +-  (symmetric)
    //   examples:  ±0.05   +/-0.05   +-0.05   + - 0.05
    const symRe = /^(?:\u00b1|\+\s*\/\s*-|\+\s*-)\s*(\d+(?:[.,]\d+)?)/;
    const symMatch = rest.match(symRe);
    if (symMatch) {
      const v = symMatch[1].replace(',', '.');
      return { mainValue, plusTol: '+' + v, minusTol: '-' + v };
    }

    // ─── Case 2: A/B  (slash-separated, each part may have an explicit sign)
    //   examples:  +0.10/-0.10   +0.02/+0.01   -0.01/-0.03   0/-0.05
    const slashRe = /^([+-]?\s*\d+(?:[.,]\d+)?)(?:\s*\/\s*|\s+)([+-]?\s*\d+(?:[.,]\d+)?)/;
    const slashMatch = rest.match(slashRe);
    if (slashMatch) {
      const a = withSign(slashMatch[1]);
      const b = withSign(slashMatch[2]);
      // Convention: upper tolerance first (+ value), lower second (- value)
      // But respect what the user typed — if both are + store as-is, etc.
      const valA = parseFloat(a);
      const valB = parseFloat(b);
      // Put the larger value in Upper Tolerance (plusTol) and smaller in Lower (minusTol)
      if (valA >= valB) {
        plusTol = a;
        minusTol = b;
      } else {
        plusTol = b;
        minusTol = a;
      }
      return { mainValue, plusTol, minusTol };
    }

    // ─── Case 3: single tolerance  +X  or  -X  (unilateral)
    const singleRe = /^([+-])\s*(\d+(?:[.,]\d+)?)/;
    const singleMatch = rest.match(singleRe);
    if (singleMatch) {
      const v = singleMatch[1] + singleMatch[2].replace(',', '.');
      if (v.startsWith('+')) { plusTol = v; }
      else { minusTol = v; }
      return { mainValue, plusTol, minusTol };
    }

    return { mainValue, plusTol: '', minusTol: '' };
  };

  const syncEditFromBalloon = (balloonId) => {
    const characteristic = characteristics.find(
      (item) => item.balloonId === balloonId
    );

    if (!characteristic) return;

    setCurrentBalloonNo(String(characteristic.number ?? ''));

    /* The stored specification is the display text - show it exactly
       as saved (same as the table). Only value / tolerances are
       normalised, and only from text that parses confidently. */
    const normalized = normalizeCallout(characteristic);

    setEditData({
      characteristicId: characteristic._id,
      balloonId:        characteristic.balloonId,
      number:           String(characteristic.number ?? ''),
      specification:    characteristic.specification || '',
      value:            normalized ? normalized.value : (characteristic.value || ''),
      plusTolerance:    normalized ? normalized.plusTolerance : (characteristic.plusTolerance || ''),
      minusTolerance:   normalized ? normalized.minusTolerance : (characteristic.minusTolerance || '')
    });
  };

  const loadCharacteristicByNumber = (rawNumber) => {
    const text = String(rawNumber ?? '').trim();

    if (!text) {
      setEditData(null);
      return;
    }

    const number = Number(text);

    if (!Number.isFinite(number)) return;

    const characteristic = characteristics.find(
      (item) => Number(item.number) === number
    );

    if (!characteristic) {
      setMessage(`No balloon with number ${number}`);
      return;
    }

    setSelectedBalloonId(characteristic.balloonId);
    syncEditFromBalloon(characteristic.balloonId);
    setMessage(`Balloon ${number} loaded`);
  };

  const handleBalloonNumberChange = (value) => {
    setCurrentBalloonNo(value);

    // Auto-load details only when nothing is currently being
    // edited, so an existing balloon's number can still be
    // changed freely.
    if (!editData) {
      loadCharacteristicByNumber(value);
    }
  };

  const handleBalloonNumberKeyDown = (event) => {
    if (event.key === 'Enter') {
      loadCharacteristicByNumber(currentBalloonNo);
    }
  };

  /*
    A bare symmetric tolerance typed into any panel field
    ("±0.05") is not a dimension on its own - split it so the
    value lands in BOTH tolerance boxes.
  */
  const extractSymmetricTol = (text) => {
    const m = String(text ?? '').match(/^\s*±\s*(\d+(?:\.\d+)?)\s*$/);
    return m ? m[1] : null;
  };

  /*
    The value field recomposes the specification on every keystroke,
    so by the time "±0.05" is complete the old nominal number is gone
    from editData. Stash it when the field receives focus and put it
    back when the typed text turns out to be a tolerance. The split
    happens on Enter/blur only - mutating the box while typing would
    eat the "±" the user is still typing behind.
  */
  const valueNominalStashRef = useRef('');
  const commitValueField = () => {
    const symTol = extractSymmetricTol(editData?.value);
    if (!symTol) {
      saveEdit();
      return;
    }
    const nominal = valueNominalStashRef.current || '';
    const nextData = {
      ...editData,
      value: nominal,
      plusTolerance: symTol,
      minusTolerance: symTol,
      specification: composeSpecification(nominal, symTol, symTol, '')
    };
    setEditData(nextData);
    setTimeout(() => saveEdit(nextData), 50);
  };

  /*
    Same split for the tolerance boxes: "±0.05" typed into either box
    fills BOTH boxes on Enter/blur.
  */
  const commitTolField = (which) => {
    const raw = which === 'plusTolerance'
      ? editData?.plusTolerance
      : editData?.minusTolerance;
    const symTol = extractSymmetricTol(raw);
    if (!symTol) {
      saveEdit();
      return;
    }
    const nextData = {
      ...editData,
      plusTolerance: symTol,
      minusTolerance: symTol,
      specification: composeSpecification(editData?.value, symTol, symTol, '')
    };
    setEditData(nextData);
    setTimeout(() => saveEdit(nextData), 50);
  };

  const saveEdit = async (overrideData = null) => {
    // If overrideData is a DOM Event (from onBlur), ignore it and use editData
    const dataToSave = (overrideData && overrideData.characteristicId) ? overrideData : editData;
    if (!dataToSave?.characteristicId) {
      setMessage('Enter a balloon number or select a balloon first');
      return;
    }

    try {
      setSavingCharacteristicId(dataToSave.characteristicId);

      const number = Number(currentBalloonNo || dataToSave.number);
      setEditData(prev => ({ ...prev, number: String(number) }));

      /* Store the text the user actually typed. Only derive the
         value / tolerances / limits from it when the specification
         parses confidently; otherwise save every field verbatim so
         callouts like "0.5×45°" are never rebuilt from a stale
         value and lose the extra characters. */
      const specText =
        typeof dataToSave.specification === 'string'
          ? dataToSave.specification
          : '';
      const specParts = specText ? parseCalloutText(specText) : null;
      const specConfident = !!(specParts && specParts.confident);
      const existing = characteristics.find(
        (item) => item._id === dataToSave.characteristicId
      );
      const normalized = specConfident
        ? normalizeCallout(
            {
              ...dataToSave,
              specification: specText,
              type: existing && existing.type
            },
            { prefer: 'spec' }
          )
        : null;

      const updated = await api.put(
        `/characteristics/${dataToSave.characteristicId}`,
        normalized
          ? {
              number,
              specification: specText,
              value: normalized.value,
              plusTolerance: normalized.plusTolerance,
              minusTolerance: normalized.minusTolerance,
              upperLimit: normalized.upperLimit,
              lowerLimit: normalized.lowerLimit,
              type: normalized.type
            }
          : {
              number,
              specification: specText,
              value: dataToSave.value ?? '',
              plusTolerance: dataToSave.plusTolerance ?? '',
              minusTolerance: dataToSave.minusTolerance ?? ''
            }
      );

      // Keep the balloon number on the drawing in sync
      await api.put(
        `/balloons/${dataToSave.balloonId}`,
        { number }
      );

      if (updated) {
        setCharacteristics((prev) =>
          prev.map((item) =>
            item._id === dataToSave.characteristicId
              ? { ...item, ...updated }
              : item
          )
        );
      }

      setBalloons((prev) =>
        prev.map((item) =>
          item._id === dataToSave.balloonId
            ? { ...item, number }
            : item
        )
      );

      setMessage('Balloon saved');
    } catch (error) {
      console.error('Failed to save balloon:', error);
      setMessage(error.message || 'Failed to save balloon');
    } finally {
      setSavingCharacteristicId(null);
    }
  };

  // Populate the edit panel when a balloon is clicked on the drawing
  const prevSelectedBalloonRef = useRef(null);
  const isEditPanelFocused = () => {
    const el = document.activeElement;
    if (!el || el.tagName !== 'INPUT') return false;
    const placeholder = el.getAttribute('placeholder');
    return placeholder === '—' || placeholder === 'Enter balloon number';
  };
  useEffect(() => {
    const selectionChanged =
      prevSelectedBalloonRef.current !== selectedBalloonId;
    prevSelectedBalloonRef.current = selectedBalloonId;

    if (selectedBalloonId) {
      /* Never re-populate the panel while the user is typing in it -
         every characteristics refresh (e.g. the auto-save fired by
         blurring another field) would otherwise wipe the text they
         are in the middle of entering. */
      if (selectionChanged || !isEditPanelFocused()) {
        syncEditFromBalloon(selectedBalloonId);
      }
    } else {
      setCurrentBalloonNo('');
      setEditData(null);
    }
  }, [selectedBalloonId, characteristics]);

  const getDisplayValues = (c) => {
    const normalized = normalizeCallout(c);
    return {
      /*
        The stored specification is already the display text -
        re-normalizing would rebuild it from the bare value and
        drop quantity / depth wording of stacked notes
        ("3 x Ø 4.2 12" -> "3 X Ø 4.2").
      */
      specification:
        c.specification ||
        (normalized && normalized.specification) ||
        '',
      mainVal: normalized ? normalized.value : c.value || '',
      plusTol: normalized
        ? normalized.plusTolerance
        : c.plusTolerance || '',
      minusTol: normalized
        ? normalized.minusTolerance
        : c.minusTolerance || ''
    };
  };

  const exportToExcel = () => {
    const data = characteristics
      .slice()
      .sort((a, b) => Number(a.number || 0) - Number(b.number || 0))
      .map(c => {
        const d = getDisplayValues(c);
        return {
          'Balloon No': c.number || '',
          'Description': d.specification || '',
          'Dimensions No': d.mainVal || '',
          'Upper Tolerance': d.plusTol || '',
          'Lower Tolerance': d.minusTol || ''
        };
      });

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Characteristics');
    
    // Name the file based on the project ID or just generic name
    XLSX.writeFile(workbook, `Ballooning_Report_${id || 'Export'}.xlsx`);
  };

  /* =========================================================
     DRAG BALLOON
  ========================================================= */

  const handleBalloonPointerDown = (
    event,
    balloon
  ) => {
    event.stopPropagation();

    setSelectedBalloonId(
      balloon._id
    );

    dragBalloonRef.current = {
      balloonId: balloon._id,
      lastX: event.clientX,
      lastY: event.clientY,
      initialX: event.clientX,
      initialY: event.clientY,
      maxDistance: 0,
      moved: false
    };

    event.currentTarget.setPointerCapture?.(
      event.pointerId
    );
  };

  const handleAnchorPointerDown = (event, balloon) => {
    event.stopPropagation();
    setSelectedBalloonId(balloon._id);
    dragBalloonRef.current = {
      balloonId: balloon._id,
      lastX: event.clientX,
      lastY: event.clientY,
      initialX: event.clientX,
      initialY: event.clientY,
      maxDistance: 0,
      moved: false,
      isAnchorDrag: true
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleBalloonPointerMove = (
    event
  ) => {
    const drag =
      dragBalloonRef.current;

    if (!drag) {
      return;
    }

    /*
      Remember how far the pointer travelled during THIS gesture.
      The release handler uses it to tell a drag from a click, so
      that a drag which ends near where it started can no longer be
      mistaken for a click - and a click is the only thing allowed
      to re-read (and therefore overwrite) the stored value.
      Tracked before the view-size guard so a move is never lost.
    */
    if (
      Number.isFinite(event.clientX) &&
      Number.isFinite(event.clientY)
    ) {
      const travelled = Math.hypot(
        event.clientX - drag.initialX,
        event.clientY - drag.initialY
      );

      if (travelled > drag.maxDistance) {
        drag.maxDistance = travelled;
      }

      if (travelled > DRAG_CLICK_THRESHOLD) {
        drag.moved = true;
      }
    }

    if (!viewSize.w || !viewSize.h) {
      return;
    }

    /*
      Positions live in page-relative fractions, so pointer
      deltas (screen px) are converted against the current
      on-screen size of the drawing.
    */

    const dx = (event.clientX - drag.lastX) / viewSize.w;
    const dy = (event.clientY - drag.lastY) / viewSize.h;

    drag.lastX = event.clientX;
    drag.lastY = event.clientY;

    setBalloons((prev) =>
      prev.map((balloon) => {
        if (balloon._id !== drag.balloonId) return balloon;

        if (balloon.xRel == null) return balloon;

        if (drag.isAnchorDrag) {
          const newAx = clamp01(
            (balloon.anchorXRel ?? balloon.xRel) + dx
          );
          const newAy = clamp01(
            (balloon.anchorYRel ?? balloon.yRel) + dy
          );
          return { ...balloon, anchorXRel: newAx, anchorYRel: newAy };
        }

        const newX = clamp01(balloon.xRel + dx);
        const newY = clamp01(balloon.yRel + dy);
        return { ...balloon, xRel: newX, yRel: newY };
      })
    );
  };

  const handleBalloonPointerUp =
    async (event) => {
      const drag =
        dragBalloonRef.current;

      if (!drag) return;

      dragBalloonRef.current =
        null;

      const balloon =
        balloons.find(
          (item) =>
            item._id ===
            drag.balloonId
        );

      if (!balloon) return;
      
      /*
        A gesture only counts as a click when we have the release
        coordinates AND neither the tracked travel nor the release
        point exceeded the threshold. Falling back to
        `event.clientX ?? drag.initialX` used to force the distance
        to 0 for a pointer-up without coordinates, so a drag was
        misread as a click and re-ran the detector over a value the
        user had already corrected.
      */
      const hasPointerCoords =
        Number.isFinite(event?.clientX) &&
        Number.isFinite(event?.clientY);

      const releaseDistance = hasPointerCoords
        ? Math.hypot(
            event.clientX - drag.initialX,
            event.clientY - drag.initialY
          )
        : Infinity;

      const movedDistance = Math.max(
        Number(drag.maxDistance) || 0,
        releaseDistance
      );

      const isClick =
        hasPointerCoords &&
        movedDistance < DRAG_CLICK_THRESHOLD &&
        drag.moved !== true;

      const isAnchorDrag = drag.isAnchorDrag === true;

      const characteristic = characteristics.find(item => item.balloonId === balloon._id);
      const metrics = canvasMetrics();

      const xRel = balloon.xRel ?? (metrics ? clamp01(balloon.x / metrics.w) : null);
      const yRel = balloon.yRel ?? (metrics ? clamp01(balloon.y / metrics.h) : null);
      const anchorXRel =
        balloon.anchorXRel ??
        (metrics && balloon.anchorX != null
          ? clamp01(balloon.anchorX / metrics.w)
          : null);
      const anchorYRel =
        balloon.anchorYRel ??
        (metrics && balloon.anchorY != null
          ? clamp01(balloon.anchorY / metrics.h)
          : null);

      /* ---------------------------------------------------------
         CLICK (not drag): read dimension at anchor and update
         --------------------------------------------------------- */
      if (isClick && !isAnchorDrag && pdfPage) {
        console.log('[BalloonClick] Reading dimension at anchor:', {
          balloonId: balloon._id,
          balloonNumber: balloon.number,
          anchorX: Math.round(anchorXRel * metrics.w),
          anchorY: Math.round(anchorYRel * metrics.h)
        });

        try {
          const anchorX = anchorXRel * metrics.w;
          const anchorY = anchorYRel * metrics.h;

          const detected = await readDimensionAtPoint(anchorX, anchorY);

          if (detected) {
            console.log('[BalloonClick] Dimension detected:', {
              specification: detected.specification,
              value: detected.value,
              plusTolerance: detected.plusTolerance,
              minusTolerance: detected.minusTolerance,
              source: detected.source
            });

            /* Update characteristic in backend */
            if (characteristic) {
              const updatedChar = await api.put(`/characteristics/${characteristic._id}`, {
                specification: detected.specification,
                value: detected.value,
                plusTolerance: detected.plusTolerance,
                minusTolerance: detected.minusTolerance,
                upperLimit: detected.upperLimit,
                lowerLimit: detected.lowerLimit,
                type: detected.type,
                status: detected.source === 'pdf' ? 'Verified' : 
                       (detected.source?.startsWith('ocr') && detected.ocrConfidence >= 50 ? 'Verified' : 'Needs verification')
              });

              if (updatedChar) {
                setCharacteristics(prev =>
                  prev.map(item => item._id === characteristic._id ? { ...item, ...updatedChar } : item)
                );
              }
            }

            /* Update balloon text */
            const updatedBalloon = await api.put(`/balloons/${balloon._id}`, {
              text: detected.text,
              type: detected.type,
              status: detected.source === 'pdf' ? 'Verified' : 
                     (detected.source?.startsWith('ocr') && detected.ocrConfidence >= 50 ? 'Verified' : 'Needs verification')
            });

            setBalloons(prev => prev.map(item => item._id === balloon._id ? { ...item, ...updatedBalloon } : item));

            /* Refresh editor panel */
            syncEditFromBalloon(balloon._id);

            setMessage(`Balloon ${balloon.number}: dimension read as "${detected.specification}"`);
          } else {
            setMessage(`Balloon ${balloon.number}: no dimension found at anchor`);
          }
        } catch (error) {
          console.error('[BalloonClick] Dimension read failed:', error);
          setMessage('Failed to read dimension');
        }
        
        /* Click handled - don't proceed to drag logic */
        return;
      }

      /* ---------------------------------------------------------
         DRAG: save new position
         --------------------------------------------------------- */
      try {
        const updatedBalloon = await api.put(`/balloons/${balloon._id}`, {
          xRel,
          yRel,
          anchorXRel,
          anchorYRel,
          x: metrics && xRel != null ? xRel * metrics.w : balloon.x,
          y: metrics && yRel != null ? yRel * metrics.h : balloon.y,
          anchorX:
            metrics && anchorXRel != null
              ? anchorXRel * metrics.w
              : balloon.anchorX,
          anchorY:
            metrics && anchorYRel != null
              ? anchorYRel * metrics.h
              : balloon.anchorY
        });

        if (characteristic) {
          await api.put(`/characteristics/${characteristic._id}`, {
            xRel,
            yRel,
            x: metrics && xRel != null ? xRel * metrics.w : characteristic.x,
            y: metrics && yRel != null ? yRel * metrics.h : characteristic.y
          });
          
          setCharacteristics(prev =>
            prev.map(item => item._id === characteristic._id ? { ...item, xRel, yRel } : item)
          );
        }

        setBalloons(prev => prev.map(item => item._id === balloon._id ? { ...item, ...updatedBalloon } : item));
        setMessage(`Balloon ${balloon.number} moved`);
      } catch (error) {
        console.error(
          'Failed to save balloon position:',
          error
        );

        setMessage(
          error.message ||
          'Failed to save balloon position'
        );
      }
    };
  /* =========================================================
     DIMENSION READING (shared by balloon drop + Add Dimension)
     ---------------------------------------------------------
     collectDimensionItems  - reads the PDF text layer
     findNearestDimension   - nearest characteristic to a point
     parseNearestDimension  - value / tolerances / limits
     ocrReadRegion          - OCR fallback for scanned drawings
     scanDimensionInRect    - used by the Add Dimension tool
     readDimensionAtPoint   - used when a balloon is dropped
  ========================================================= */

  const collectDimensionItems = async () => {
    if (!pdfPage) {
      return [];
    }

    const baseViewport =
      pdfPage.getViewport({
        scale: 1
      });

    let displayScale = 1;

    if (canvasRef.current) {
      displayScale =
        canvasRef.current.width /
        baseViewport.width;
    }

    const textContent =
      await pdfPage.getTextContent();

    const items = [];

    for (const item of textContent.items) {
      if (!item.str || !item.str.trim()) {
        continue;
      }

      const text =
        normalizeDetectionText(item.str);

      if (!isDetectionText(text)) {
        continue;
      }

      const point =
        baseViewport.convertToViewportPoint(
          item.transform?.[4] || 0,
          item.transform?.[5] || 0
        );

      /*
        Text-space directions in display coordinates - lets the
        vector-Ø inspector build the slot before a number even when
        the dimension text is rotated.
      */
      const vt = baseViewport.transform;
      const tr = item.transform || [1, 0, 0, 1, 0, 0];

      const mat = [
        (vt[0] * tr[0] + vt[2] * tr[1]) * displayScale,
        (vt[1] * tr[0] + vt[3] * tr[1]) * displayScale,
        (vt[0] * tr[2] + vt[2] * tr[3]) * displayScale,
        (vt[1] * tr[2] + vt[3] * tr[3]) * displayScale
      ];

      // Removed region constraints so users can manually balloon anything anywhere

      items.push({
        text,

        x:
          point[0] * displayScale,

        y:
          point[1] * displayScale,

        width:
          Number(item.width || 0) *
          displayScale,

        height:
          Number(item.height || 0) *
          displayScale,

        mat,

        confidence: 1,

        source: 'pdf'
      });
    }

    return items;
  };

  const findNearestDimension = (
    items,
    pointX,
    pointY,
    maxDistance = 150 * dRatio
  ) => {
    let nearest = null;
    let nearestDistance = Infinity;

    for (const item of items) {
      const dx =
        detectionCenterX(item) - pointX;

      const dy =
        detectionCenterY(item) - pointY;

      const distance = Math.sqrt(
        dx * dx + dy * dy
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = item;
      }
    }

    if (
      !nearest ||
      nearestDistance > maxDistance
    ) {
      return null;
    }

    return nearest;
  };

  /* =========================================================
     VECTOR DIAMETER (Ø) INSPECTION
     ---------------------------------------------------------
     CAD drawings often draw the Ø glyph as vector art while the
     number stays as selectable text. These helpers render the
     page once at high resolution and inspect the pixel slot
     immediately BEFORE the number:

     - a Ø ring leaves a dense centre (>= 0.145) with no row of
       ink spanning the slot (maxRow < 0.5)
     - depth arrows (↧), bars and leader lines fill a whole row
       and are rejected; empty slots have no centre ink at all
  ========================================================= */

  const SYMBOL_HAS_RE = /^(SØ|SR|Ø|⌀|∅|R|M)/i;

  const getSymbolRender = async () => {
    if (!pdfPage) return null;

    const scale = 6;
    const cached = ocrCacheRef.current;

    if (
      cached &&
      cached.page === pdfPage &&
      cached.scale === scale
    ) {
      return cached;
    }

    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const ctx = canvas.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(160%) brightness(105%)';
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;

    const entry = { page: pdfPage, scale, canvas };
    ocrCacheRef.current = entry;
    return entry;
  };

  const detectDiameterSymbol = async (item) => {
    try {
      if (!pdfPage || !item || !item.height || !canvasRef.current) {
        return false;
      }

      const cachedBefore = !!(
        ocrCacheRef.current &&
        ocrCacheRef.current.page === pdfPage &&
        ocrCacheRef.current.scale === 6
      );
      const render = await getSymbolRender();
      if (!render) return false;

      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const displayScale =
        canvasRef.current.width / baseViewport.width;
      const ratio = render.scale / displayScale;

      const h = item.height;
      let x1;
      let y1;
      let x2;
      let y2;

      if (item.mat) {
        const [A, B, C, D] = item.mat;
        const uxN = Math.hypot(A, B) || 1;
        const uyN = Math.hypot(C, D) || 1;
        const ux = [A / uxN, B / uxN];
        const uy = [C / uyN, D / uyN];
        const px = [-1.35 * h, -0.12 * h];
        const qy = [-0.05 * h, 1.05 * h];
        const xs = [];
        const ys = [];

        for (const p of px) {
          for (const q of qy) {
            xs.push(item.x + p * ux[0] + q * uy[0]);
            ys.push(item.y + p * ux[1] + q * uy[1]);
          }
        }

        x1 = Math.min(...xs);
        x2 = Math.max(...xs);
        y1 = Math.min(...ys);
        y2 = Math.max(...ys);
      } else {
        x1 = item.x - 1.35 * h;
        x2 = item.x - 0.12 * h;
        y1 = item.y - 1.05 * h;
        y2 = item.y + 0.05 * h;
      }

      const sx = x1 * ratio;
      const sy = y1 * ratio;
      const sw = (x2 - x1) * ratio;
      const sh = (y2 - y1) * ratio;

      if (!(sw > 1) || !(sh > 1)) return false;

      const crop = document.createElement('canvas');
      crop.width = Math.ceil(sw);
      crop.height = Math.ceil(sh);

      const ctx = crop.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(render.canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

      const data = ctx.getImageData(0, 0, crop.width, crop.height).data;
      const rowCount = new Array(crop.height).fill(0);

      for (let y = 0; y < crop.height; y++) {
        for (let x = 0; x < crop.width; x++) {
          const i = (y * crop.width + x) * 4;
          const gray =
            0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (gray < 170) rowCount[y]++;
        }
      }

      const maxRow = Math.max(...rowCount) / crop.width;

      const cy0 = Math.floor(crop.height * 0.3);
      const cy1 = Math.ceil(crop.height * 0.7);
      const cx0 = Math.floor(crop.width * 0.3);
      const cx1 = Math.ceil(crop.width * 0.7);

      let centerDark = 0;
      let centerTotal = 0;

      for (let y = cy0; y < cy1; y++) {
        for (let x = cx0; x < cx1; x++) {
          const i = (y * crop.width + x) * 4;
          const gray =
            0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          centerTotal++;
          if (gray < 170) centerDark++;
        }
      }

      const centerDensity = centerTotal ? centerDark / centerTotal : 0;

      if (typeof window !== 'undefined' && window.__slotDebug) {
        let totalDark = 0;
        const totalPx = crop.width * crop.height;
        for (let y = 0; y < crop.height; y++) {
          for (let x = 0; x < crop.width; x++) {
            const i = (y * crop.width + x) * 4;
            const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (gray < 170) totalDark++;
          }
        }
        console.log(
          '[diameter-detect] slot',
          JSON.stringify(item.text), 'pos=', Math.round(item.x) + ',' + Math.round(item.y),
          'rect=', [x1, y1, x2, y2].map((v) => Math.round(v)).join(','),
          'crop=', crop.width + 'x' + crop.height,
          'ctr=', centerDensity.toFixed(3), 'maxRow=', maxRow.toFixed(3),
          'totalDark=', (totalDark / totalPx).toFixed(3),
          'cached=', cachedBefore, 'ratio=', ratio.toFixed(2)
        );
      }

      return centerDensity >= 0.145 && maxRow < 0.5;
    } catch (error) {
      console.warn('[diameter-detect] slot analysis failed:', error);
      return false;
    }
  };

  const attachGeometryDiameter = async (
    result,
    items,
    centerX,
    centerY
  ) => {
    try {
      if (
        !result ||
        SYMBOL_HAS_RE.test(String(result.value || '').trim())
      ) {
        return result;
      }

      const numMatch = String(result.value || '').match(
        /\d+(?:\.\d+)?/
      );

      if (!numMatch) return result;

      const num = numMatch[0];

      const candidates = items.filter((it) => {
        if (it.source && it.source !== 'pdf') return false;
        if (!it.height || !it.mat) return false;
        if (DETECTION_PATTERNS.smallTolerance.test(it.text)) return false;

        const m = normalizeDetectionText(it.text).match(
          /^\s*(\d+(?:\.\d+)?)/
        );

        return m && Number(m[1]) === Number(num);
      });

      if (candidates.length === 0) return result;

      candidates.sort(
        (a, b) =>
          Math.hypot(
            detectionCenterX(a) - centerX,
            detectionCenterY(a) - centerY
          ) -
          Math.hypot(
            detectionCenterX(b) - centerX,
            detectionCenterY(b) - centerY
          )
      );

      const base = candidates[0];

      const distance = Math.hypot(
        detectionCenterX(base) - centerX,
        detectionCenterY(base) - centerY
      );

      if (distance > 120 * dRatio) return result;

      const detected = await detectDiameterSymbol(base);

      if (!detected) return result;

      const merged = normalizeCallout({
        specification: result.specification,
        value: result.value,
        plusTolerance: result.plusTolerance,
        minusTolerance: result.minusTolerance,
        type: 'Diameter'
      });

      if (merged) {
        console.log(
          '[diameter-detect] Ø found before',
          num,
          '->',
          merged.value
        );
        return { ...result, ...merged };
      }

      return result;
    } catch (error) {
      console.warn('[diameter-detect] failed:', error);
      return result;
    }
  };

  const parseNearestDimension = (
    items,
    nearest
  ) => {
    let text =
      normalizeDetectionText(nearest.text);

    const standaloneSymbols = items.filter(item => DETECTION_PATTERNS.symbol.test(normalizeDetectionText(item.text)));
    const nearbySymbols = standaloneSymbols.filter(sym => {
      const xDiff = nearest.x - sym.x; 
      const yDiff = Math.abs(nearest.y - sym.y);
      return xDiff > -20 * dRatio && xDiff < (nearest.width || 30 * dRatio) * 3 && yDiff < 30 * dRatio;
    });
    
    if (nearbySymbols.length > 0) {
      text = normalizeDetectionText(nearbySymbols[0].text + text);
    }

    let plusTolerance = '0.00';
    let minusTolerance = '0.00';
    let cleanedValue = text;

    const plusMinusMatch =
      text.match(
        /^\s*(?:Ø\s*)?(\d+(?:\.\d+)?)(?:\s*[A-Za-z0-9]+)*\s*(?:±|\+\/-|\+-|\+\s*-)\s*(\d+(?:\.\d+)?)/i
      );

    const bilateralMatch =
      text.match(
        /^\s*(?:Ø\s*)?(\d+(?:\.\d+)?)(?:\s*[A-Za-z0-9]+)*\s*\+(\d+(?:\.\d+)?)\s*\/\s*-(\d+(?:\.\d+)?)/i
      );

    if (plusMinusMatch) {
      cleanedValue = plusMinusMatch[1];
      plusTolerance = plusMinusMatch[2];
      minusTolerance = plusMinusMatch[2];
    }

    if (bilateralMatch) {
      cleanedValue = bilateralMatch[1];
      plusTolerance = bilateralMatch[2];
      minusTolerance = bilateralMatch[3];
    }

    const diameterMatch =
      text.match(/Ø\s*(\d+(?:\.\d+)?)/i);

    if (
      diameterMatch &&
      !plusMinusMatch &&
      !bilateralMatch
    ) {
      cleanedValue = diameterMatch[1];
    }

    const radiusMatch =
      text.match(/R\s*(\d+(?:\.\d+)?)/i);

    if (
      radiusMatch &&
      !plusMinusMatch &&
      !bilateralMatch
    ) {
      cleanedValue = radiusMatch[1];
    }

    const numericMatch =
      text.match(
        /^\s*(\d+(?:\.\d+)?)\s*(?:mm|in|inch|inches)?\s*$/i
      );

    if (
      numericMatch &&
      !plusMinusMatch &&
      !bilateralMatch
    ) {
      cleanedValue = numericMatch[1];
    }

    /*
      Angle callouts keep the degree symbol in the VALUE.

      normalizeCallout rebuilds the specification from the value
      text, so a value of "15" would silently drop the "°" that only
      lives in the raw reading - and the characteristic would store
      "15" / type Dimension instead of "15°" / type Angle.
      Covers "15°", "30° ±0.5°" and the note form "ANGLE 30° ±0.5°".
    */
    const angleMatch =
      !plusMinusMatch &&
      !bilateralMatch &&
      text.match(
        /^\s*(?:ANGLE\s+)?(\d+(?:\.\d+)?)\s*°\s*(?:[±]\s*(\d+(?:\.\d+)?)\s*°?)?\s*$/i
      );

    if (angleMatch) {
      cleanedValue = `${angleMatch[1]}°`;
      if (angleMatch[2]) {
        plusTolerance = angleMatch[2];
        minusTolerance = angleMatch[2];
      }
    }

    /*
      Hole / fit callout such as "25 H7" or "Ø 25 H7/g6".
      Fall back to the first number.
    */

    if (
      !plusMinusMatch &&
      !bilateralMatch &&
      !diameterMatch &&
      !radiusMatch &&
      !numericMatch &&
      !angleMatch
    ) {
      const firstNumber =
        text.match(
          /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*(\d+(?:\.\d+)?)/
        );

      if (firstNumber) {
        cleanedValue = firstNumber[1];
      }
    }

    // Combine a standalone tolerance that sits right
    // next to the value (16 / 0.05 / 0.03).
    if (
      !plusMinusMatch &&
      !bilateralMatch
    ) {
      const standaloneTolerances =
        items.filter((item) =>
          DETECTION_PATTERNS.smallTolerance.test(
            normalizeDetectionText(item.text)
          )
        );

      const isNearbyTolerance = (
        dimension,
        tolerance
      ) => {
        const xDifference =
          Math.abs(
            detectionCenterX(dimension) -
            detectionCenterX(tolerance)
          );

        const yDifference =
          Math.abs(
            dimension.y -
            tolerance.y
          );

        const maxXDistance =
          Math.max(
            45,
            (dimension.width || 20) * 2.5
          );

        const maxYDistance =
          Math.max(
            60,
            (dimension.height || 12) * 4
          );

        return (
          xDifference <= maxXDistance &&
          yDifference <= maxYDistance
        );
      };

      const nearby = standaloneTolerances
        .filter((tolerance) =>
          isNearbyTolerance(nearest, tolerance)
        )
        .sort((a, b) => a.y - b.y)
        .slice(0, 2);

      const getToleranceNumber = (
        targetItem
      ) => {
        let text =
          normalizeDetectionText(
            targetItem.text
          );

        const standaloneSymbols = items.filter(item => DETECTION_PATTERNS.symbol.test(normalizeDetectionText(item.text)));
        const nearbySymbols = standaloneSymbols.filter(sym => {
          const xDiff = targetItem.x - sym.x; 
          const yDiff = Math.abs(targetItem.y - sym.y);
          return xDiff > -20 * dRatio && xDiff < (targetItem.width || 30 * dRatio) * 3 && yDiff < 30 * dRatio;
        });
        
        if (nearbySymbols.length > 0) {
          text = normalizeDetectionText(nearbySymbols[0].text + text);
        }

        const match = text.match(/[+-]?\s*(0?\.\d{1,3})/);

        return match
          ? Number(match[1])
          : null;
      };

      if (nearby.length === 1) {
        const toleranceValue =
          getToleranceNumber(nearby[0]);

        if (
          Number.isFinite(toleranceValue)
        ) {
          plusTolerance =
            toleranceValue.toFixed(3);

          minusTolerance =
            toleranceValue.toFixed(3);
        }
      }

      if (nearby.length >= 2) {
        const firstValue =
          getToleranceNumber(nearby[0]);

        const secondValue =
          getToleranceNumber(nearby[1]);

        if (
          Number.isFinite(firstValue) &&
          Number.isFinite(secondValue)
        ) {
          const firstHasPlus =
            /^\+/.test(
              normalizeDetectionText(nearby[0].text)
            );

          const firstHasMinus =
            /^-/.test(
              normalizeDetectionText(nearby[0].text)
            );

          const secondHasPlus =
            /^\+/.test(
              normalizeDetectionText(nearby[1].text)
            );

          const secondHasMinus =
            /^-/.test(
              normalizeDetectionText(nearby[1].text)
            );

          if (firstHasPlus && secondHasMinus) {
            plusTolerance = firstValue.toFixed(3);
            minusTolerance = secondValue.toFixed(3);
          } else if (
            firstHasMinus &&
            secondHasPlus
          ) {
            plusTolerance = secondValue.toFixed(3);
            minusTolerance = firstValue.toFixed(3);
          } else {
            plusTolerance = firstValue.toFixed(3);
            minusTolerance = secondValue.toFixed(3);
          }
        }
      }
    }

    let type = 'Dimension';

    if (/^\s*Ø/.test(text)) {
      type = 'Diameter';
    } else if (/^\s*R\s*\d/.test(text)) {
      type = 'Radius';
    } else if (/[°]/.test(text)) {
      type = 'Angle';
    }

    let prefix = '';
    const prefixMatch = text.match(/^\s*(Ø|R|SØ|SR|M|∅)/i);
    if (prefixMatch) {
      prefix = prefixMatch[1].toUpperCase();
    }
    const value = String(cleanedValue).toUpperCase().startsWith(prefix) 
      ? cleanedValue 
      : prefix + cleanedValue;

    const numericValue = Number(value);
    const plus = Number(plusTolerance.replace(/^\+/, ''));
    const minus = Number(minusTolerance.replace(/^-/, ''));

    let upperLimit = '0.00';
    let lowerLimit = '0.00';

    if (Number.isFinite(numericValue)) {
      upperLimit = (
        numericValue +
        (Number.isFinite(plus) ? plus : 0)
      ).toFixed(3);

      lowerLimit = (
        numericValue -
        (Number.isFinite(minus) ? minus : 0)
      ).toFixed(3);
    }

    let specification = text;

    if (!plusMinusMatch && !bilateralMatch) {
      if (
        plusTolerance !== '0.00' ||
        minusTolerance !== '0.00'
      ) {
        specification =
          plusTolerance === minusTolerance
            ? `${text} ±${plusTolerance}`
            : `${text} +${plusTolerance}/-${minusTolerance}`;
      }
    }

    /*
      Rebuild the callout in canonical order - drawings stack the
      tolerances around the value, so the raw reading order is often
      "+0.05 7.2 +0.03" instead of "7.2 +0.05 +0.03".

      The raw reading is the source of truth here: value and
      tolerances were derived from it, so the specification wins
      whenever it parses confidently. Preferring the value instead
      would rebuild the text from a bare number and drop the "°"
      of "15°" (and the "x45° TYP" of a chamfer note).
    */
    const normalized = normalizeCallout(
      {
        specification,
        value,
        plusTolerance,
        minusTolerance,
        type
      },
      { prefer: 'spec' }
    );

    if (normalized) {
      return {
        text,
        value: normalized.value,
        type: normalized.type,
        plusTolerance: normalized.plusTolerance,
        minusTolerance: normalized.minusTolerance,
        upperLimit: normalized.upperLimit,
        lowerLimit: normalized.lowerLimit,
        specification: normalized.specification,
        centerX: detectionCenterX(nearest),
        centerY: detectionCenterY(nearest)
      };
    }

    return {
      text,
      value,
      type,
      plusTolerance,
      minusTolerance,
      upperLimit,
      lowerLimit,
      specification,
      centerX: detectionCenterX(nearest),
      centerY: detectionCenterY(nearest)
    };
  };

  /* =========================================================
     GENERAL DIMENSION READING PIPELINE
     ---------------------------------------------------------
     Reusable function: readDimensionAtPoint(anchorX, anchorY, options)
     Works for ANY drawing, ANY balloon, ANY coordinate.
     ---------------------------------------------------------
     1. Search PDF text layer near anchor
     2. If no valid dimension found, run multi-orientation OCR
     3. Score all candidates (PDF + OCR normal + OCR CW90 + OCR CCW90)
     4. Select best candidate by distance, confidence, pattern validity
     5. Parse using existing dimension parser

     options.rect (Add Dimension drag) focuses the pipeline on the
     dragged box: the OCR crop covers it, candidates are measured from
     its edge instead of the anchor point, and a candidate sitting
     inside it is scored above everything outside. Nothing is thrown
     away for being outside - a small callout whose OCR box lands just
     past the operator's edge is still the best reading available.
     ========================================================= */

  const readDimensionAtPoint = async (
    anchorX,
    anchorY,
    options = {}
  ) => {
    const {
      searchRadius = 120 * dRatio,
      ocrScale = 6,
      rect = null,
      /*
        A dragged selection is the operator pointing straight at a
        callout, so the per-word confidence floor drops from 30 to 20.
        Rotated (vertical) readings score lower than horizontal ones,
        and isReadableCallout still rejects anything that does not
        parse as a real value - the box then weighs what survived
        towards the spot the operator actually marked.
      */
      minOcrConfidence = rect ? 20 : 30
    } = options;

    if (!pdfPage) {
      console.log('[DimensionRead] No pdfPage available');
      return null;
    }

    /*
      The Add Dimension tool drags a box over a dimension. Everything
      inside that box is what the operator asked for, so candidates are
      measured against the BOX (0 while inside, edge distance outside)
      instead of its centre point - and being inside then adds to the
      score rather than filtering the pool, so a value whose own text
      box sits a hair outside the operator's edge is not thrown away.
    */
    const box = rect
      ? {
          x1: Math.min(rect.x1, rect.x2),
          y1: Math.min(rect.y1, rect.y2),
          x2: Math.max(rect.x1, rect.x2),
          y2: Math.max(rect.y1, rect.y2)
        }
      : null;

    const distanceFrom = (x, y) => {
      if (!box) {
        return Math.hypot(x - anchorX, y - anchorY);
      }
      const dx = Math.max(box.x1 - x, 0, x - box.x2);
      const dy = Math.max(box.y1 - y, 0, y - box.y2);
      return Math.hypot(dx, dy);
    };

    /* Slack keeps a reading whose OCR box just spills over the
       dragged edge from being thrown away with the rest. */
    const boxSlack = 8 * dRatio;

    const insideBox = (x, y) =>
      !!box &&
      x >= box.x1 - boxSlack &&
      x <= box.x2 + boxSlack &&
      y >= box.y1 - boxSlack &&
      y <= box.y2 + boxSlack;

    /*
      Being inside the dragged box is a ranking bonus, NOT a veto.

      The old keepInside() discarded every candidate outside the box as
      soon as any word sat inside it - and a tight drag over a small
      callout routinely catches a neighbouring glyph or a dimension-line
      tick while the value's own OCR box lands just past the edge, so
      the correct reading was in the OCR output and still thrown away.
      A valid callout pattern scores 100 against this 40, so a real
      value just outside the box still beats junk inside it, while the
      in-box value still beats its neighbours.
    */
    const insideBonus = 40;

    const baseViewport = pdfPage.getViewport({ scale: 1 });
    let displayScale = 1;
    if (canvasRef.current) {
      displayScale = canvasRef.current.width / baseViewport.width;
    }

    console.log('[DimensionRead] START', {
      anchor: { x: Math.round(anchorX), y: Math.round(anchorY) },
      searchRadius: Math.round(searchRadius),
      box: box
        ? {
            x1: Math.round(box.x1),
            y1: Math.round(box.y1),
            x2: Math.round(box.x2),
            y2: Math.round(box.y2)
          }
        : null,
      displayScale: displayScale.toFixed(2)
    });

    /*
      Small callouts ("0.5", "4", stacked tolerances) are only a few
      points tall, and at the old fixed 3.5 px/pt they landed at ~12 px
      where Tesseract returns nothing at all or mangles the glyphs.
      6 px/pt (~432 DPI) puts them back at a readable height; pushing
      higher is not free - past 8 a plain "79" starts coming back as
      "7°" - so the density is capped there.  Never below what the
      screen is showing either, so zooming in still helps.
    */
    const ocrRenderScale = Math.min(
      Math.max(ocrScale, displayScale),
      6
    );

    /* ---------------------------------------------------------
       STEP 1: PDF TEXT EXTRACTION
       --------------------------------------------------------- */
    const pdfItems = await collectDimensionItems();
    console.log('[DimensionRead] PDF items found:', pdfItems.length);

    const pdfPool = pdfItems
      .map((item) => {
        const cx = detectionCenterX(item);
        const cy = detectionCenterY(item);
        return {
          ...item,
          distance: distanceFrom(cx, cy),
          inside: insideBox(cx, cy),
          source: 'pdf'
        };
      })
      .filter((entry) => entry.distance <= searchRadius);

    const pdfCandidates = [...pdfPool].sort(
      (a, b) => a.distance - b.distance
    );

    console.log('[DimensionRead] PDF candidates in radius:', pdfCandidates.length);

    let bestCandidate = null;
    let bestScore = -Infinity;
    /* Whether the current best sits inside the dragged box. Used to
       decide whether the any-angle passes still have work to do. */
    let bestCandidateInside = false;

    /*
      Best-effort reading: a callout that HAS a number but does not
      survive parseCalloutText's confidence rules (Tesseract usually
      mangles stacked tolerances - "C ±0.05" comes back as "Cc £0.05").
      Kept in a separate pool so the confident candidates' ranking and
      the box-narrowing behaviour above stay exactly as they were, and
      used only when nothing confident turned up - so the side panel
      shows the raw reading flagged 'Needs verification' instead of an
      empty value the operator has to fill from scratch.
    */
    let bestFallback = null;
    let fallbackScore = -Infinity;

    const hasNumericValue = (parsed) =>
      /\d/.test(String((parsed && parsed.value) || ''));

    /* Score PDF candidates */
    for (const candidate of pdfCandidates) {
      const parsed = parseNearestDimension(pdfItems, candidate);
      if (!parsed) continue;

      const readable = isReadableCallout(parsed);
      if (!readable && !hasNumericValue(parsed)) continue;

      const hasValidPattern = isDimensionPattern(parsed.text);

      /*
        Proximity now decays across the WHOLE search radius instead of
        stopping at 100px - previously every candidate further away
        than 100px scored the same, so an unrelated valid dimension
        nearby could beat the value the user actually clicked on.
      */
      const proximity =
        100 *
        (1 - Math.min(candidate.distance, searchRadius) / searchRadius);

      const score =
        (hasValidPattern ? 100 : 0) +
        proximity +
        (candidate.inside ? insideBonus : 0);

      if (!readable) {
        if (score > fallbackScore) {
          fallbackScore = score;
          bestFallback = {
            ...parsed,
            source: 'pdf',
            distance: candidate.distance,
            rawText: candidate.text
          };
        }
        continue;
      }

      console.log('[DimensionRead] PDF candidate:', {
        text: parsed.text,
        spec: parsed.specification,
        distance: Math.round(candidate.distance),
        hasValidPattern,
        score
      });

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = { ...parsed, source: 'pdf', distance: candidate.distance, rawText: candidate.text };
        bestCandidateInside = candidate.inside;
      }
    }

    /* ---------------------------------------------------------
       STEP 2: MULTI-ORIENTATION OCR (if PDF didn't find strong match)
       --------------------------------------------------------- */
    const pdfFoundStrong = bestScore >= 150;
    
    if (!pdfFoundStrong) {
      console.log('[DimensionRead] PDF weak/none, running multi-orientation OCR...');

      const ocrOrientations = [
        { name: 'normal', rotation: 0 },
        { name: 'cw90', rotation: Math.PI / 2 },
        { name: 'ccw90', rotation: -Math.PI / 2 }
      ];

      const ocrPool = [];
      const ocrFallbackPool = [];

      /* One sheet render feeds every orientation and the estimate. */
      let sharedSheet = null;
      try {
        sharedSheet = await renderOcrPage(ocrRenderScale);
      } catch (error) {
        console.error('[DimensionRead] shared OCR render failed:', error);
      }

      /* Reads one orientation/window and files everything it saw. */
      const collectFromOrientation = async (orient) => {
        const ocrItems = await ocrReadRegionAtPoint(anchorX, anchorY, {
          searchRadius,
          ocrScale: ocrRenderScale,
          rotation: orient.rotation,
          minConfidence: minOcrConfidence,
          rect,
          sharedSheet,
          oblique: !!orient.oblique,
          rowBand: !!orient.rowBand
        });

        console.log(`[DimensionRead] OCR ${orient.name}: ${ocrItems.length} items`);

        for (const item of ocrItems) {
          const cx = detectionCenterX(item);
          const cy = detectionCenterY(item);
          const distance = distanceFrom(cx, cy);

          if (distance > searchRadius) continue;

          const parsed = parseNearestDimension(ocrItems, item);
          if (!parsed) continue;

          const entry = {
            parsed,
            item,
            orient,
            distance,
            inside: insideBox(cx, cy)
          };

          if (isReadableCallout(parsed)) {
            ocrPool.push(entry);
          } else if (hasNumericValue(parsed)) {
            ocrFallbackPool.push(entry);
          }
        }
      };

      for (const orient of ocrOrientations) {
        await collectFromOrientation(orient);
      }

      /*
        Vertical callouts only show up in the rotated passes, so every
        readable reading found so far is collected first and the
        dragged box then weighs the ranking instead of cutting the
        pool down to whatever happened to land inside it.

        Re-run after every additional (any-angle) pass: the pools only
        ever grow, so re-scoring raises the winner at worst, never
        knocks a previous one out.
      */
      const scoreOcrPools = (logCandidates) => {
        for (const entry of ocrPool) {
          const { parsed, item, orient, distance } = entry;

          const hasValidPattern = isDimensionPattern(parsed.text);

          const ocrConfidence = item.confidence || 0;
          const orientationBonus = orient.name === 'normal' ? 10 : 0;
          const proximity =
            100 * (1 - Math.min(distance, searchRadius) / searchRadius);
          const score = (hasValidPattern ? 100 : 0) +
                        (ocrConfidence / 2) +
                        orientationBonus +
                        proximity +
                        (entry.inside ? insideBonus : 0);

          if (logCandidates) {
            console.log('[DimensionRead] OCR candidate:', {
              orientation: orient.name,
              text: parsed.text,
              spec: parsed.specification,
              distance: Math.round(distance),
              confidence: ocrConfidence,
              hasValidPattern,
              score
            });
          }

          if (score > bestScore) {
            bestScore = score;
            bestCandidate = {
              ...parsed,
              source: `ocr-${orient.name}`,
              distance,
              rawText: item.text,
              ocrConfidence
            };
            bestCandidateInside = entry.inside;
          }
        }

        /*
          Second pass over the readings that carry a number but would
          not parse confidently. Same ranking and the same box
          weighting, but they can only ever fill the gap when the
          confident pool came up empty.
        */
        for (const entry of ocrFallbackPool) {
          const { parsed, item, orient, distance } = entry;

          const hasValidPattern = isDimensionPattern(parsed.text);
          const ocrConfidence = item.confidence || 0;
          const orientationBonus = orient.name === 'normal' ? 10 : 0;
          const proximity =
            100 * (1 - Math.min(distance, searchRadius) / searchRadius);
          const score = (hasValidPattern ? 100 : 0) +
                        (ocrConfidence / 2) +
                        orientationBonus +
                        proximity +
                        (entry.inside ? insideBonus : 0);

          if (score > fallbackScore) {
            fallbackScore = score;
            bestFallback = {
              ...parsed,
              source: `ocr-${orient.name}`,
              distance,
              rawText: item.text,
              ocrConfidence
            };
          }
        }
      };

      scoreOcrPools(true);

      const confidentFound = () =>
        bestScore >= 150 && (!box || bestCandidateInside);

      /*
        ANY-ANGLE PASSES
        ---------------------------------------------------------
        A callout written on a diagonal leader is invisible to 0° and
        ±90°: Tesseract only reads near-horizontal text, so those
        three passes return noise and the operator gets a blank (or a
        neighbour's value) for a perfectly legible dimension.

        Only started when the standard passes have nothing confident
        INSIDE the dragged box, so a normal read costs nothing extra.
        A 5 degree grid walked from 45 outwards - drawing callouts
        cluster around the 30-60 diagonal, and at 5 degree steps no
        callout can sit more than 2.5 degrees off the angle being
        read, inside Tesseract's window. Estimating the angle from
        the bitmap first was tried and dropped: a page frame or a
        chamfer edge scores higher than the glyphs it crosses, so the
        estimate missed by 7-85 degrees while the grid never missed
        by more than 2.5.

        Each angle is read twice at most: the window as cropped, and
        - only if that came back as noise - the same window with
        everything outside its glyph rows blanked, because a leader
        line riding along in the crop is enough to make Tesseract
        read the graphics instead of the value. Scoring stops the
        whole thing the moment something confident lands in the box.
      */
      if (!confidentFound()) {
        console.log('[DimensionRead] no confident reading at 0/90 - trying callout angles...');

        const toRad = (deg) => (deg * Math.PI) / 180;

        const sweep = [];
        for (let deg = 5; deg <= 85; deg += 5) {
          if (deg % 90 === 0) continue;
          sweep.push(toRad(deg), toRad(-deg));
        }
        sweep.sort(
          (a, b) =>
            Math.min(Math.abs(a - toRad(45)), Math.abs(a + toRad(45))) -
            Math.min(Math.abs(b - toRad(45)), Math.abs(b + toRad(45)))
        );

        let passes = 0;
        for (const rotation of sweep) {
          if (passes >= 12) break;
          passes += 1;
          const degrees = Math.round((rotation * 180) / Math.PI);
          await collectFromOrientation({
            name: `obl${degrees}`,
            rotation,
            oblique: true
          });
          scoreOcrPools(false);

          if (!confidentFound()) {
            await collectFromOrientation({
              name: `obl${degrees}b`,
              rotation,
              oblique: true,
              rowBand: true
            });
            scoreOcrPools(false);
          }

          if (confidentFound()) {
            console.log('[DimensionRead] any-angle pass succeeded:', {
              angle: degrees,
              score: Math.round(bestScore)
            });
            break;
          }
        }

        if (!confidentFound()) {
          console.log('[DimensionRead] any-angle passes exhausted:', {
            passes,
            bestScore: Math.round(bestScore)
          });
        }
      }
    }

    /*
      Nothing parsed cleanly, but something numeric was read at the
      spot the operator marked - hand that over flagged, rather than
      leaving the characteristic blank.
    */
    if (!bestCandidate && bestFallback) {
      console.log('[DimensionRead] BEST-EFFORT (not confident):', {
        source: bestFallback.source,
        text: bestFallback.text,
        value: bestFallback.value,
        specification: bestFallback.specification,
        distance: Math.round(bestFallback.distance || 0),
        score: Math.round(fallbackScore)
      });
      bestCandidate = { ...bestFallback, needsVerification: true };
    }

    if (!bestCandidate) {
      console.log('[DimensionRead] NO VALID CANDIDATE FOUND');
      return null;
    }

    console.log('[DimensionRead] SELECTED:', {
      source: bestCandidate.source,
      text: bestCandidate.text,
      specification: bestCandidate.specification,
      value: bestCandidate.value,
      plusTolerance: bestCandidate.plusTolerance,
      minusTolerance: bestCandidate.minusTolerance,
      distance: Math.round(bestCandidate.distance),
      score: Math.round(bestScore),
      needsVerification: !!bestCandidate.needsVerification
    });

    /* Attach geometry diameter (vector Ø detection) */
    const allItems = [...pdfItems];
    const result = await attachGeometryDiameter(
      bestCandidate,
      allItems,
      anchorX,
      anchorY
    );

    return result;
  };

  /* ---------------------------------------------------------
     One rasterisation of the sheet, shared by every OCR pass.
     ---------------------------------------------------------
     readDimensionAtPoint recognises the same window three times
     (normal / cw90 / ccw90), and it used to re-render the whole
     page for each one - at 6 px/pt that is an 18 MP canvas per
     rotation for identical pixels. Render once, crop three times.
     --------------------------------------------------------- */
  const renderOcrPage = async (scale) => {
    const viewport = pdfPage.getViewport({ scale });
    const sheet = document.createElement('canvas');
    sheet.width = Math.ceil(viewport.width);
    sheet.height = Math.ceil(viewport.height);

    const ctx = sheet.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(160%) brightness(105%)';
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;

    return sheet;
  };

  /* ---------------------------------------------------------
     Danish OCR worker - the Ø reader.
     ---------------------------------------------------------
     Tesseract's English model has no Ø glyph at all: fed a clean
     "Ø6 Ø20 R10" it answers "Bk B20 A4 RID", so on a scanned
     drawing the diameter symbol is replaced by whatever the glyph
     most resembles (2, 3, 4, 0 ...) and a Ø callout is stored as a
     plain - and wrong - number. Danish ships Ø as an ordinary
     letter and returns "Ø6" for the same bitmap, so reads that
     carry the glyph are taken from it. Falls back to English-only
     when the model cannot be loaded.
  --------------------------------------------------------- */
  const getDanWorker = async () => {
    if (ocrDanUnavailableRef.current) return null;
    if (ocrDanWorkerRef.current) return ocrDanWorkerRef.current;

    try {
      ocrDanWorkerRef.current = await createWorker('dan', 1, {
        workerPath: '/tesseract/worker.min.js',
        corePath: '/tesseract/tesseract-core.wasm.js',
        langPath: '/tesseract'
      });
      return ocrDanWorkerRef.current;
    } catch (error) {
      ocrDanUnavailableRef.current = true;
      console.warn(
        '[DimensionRead] Ø model unavailable, English OCR only:',
        error && error.message
      );
      return null;
    }
  };

  /* ---------------------------------------------------------
     OCR at specific point with rotation support
     --------------------------------------------------------- */
  const ocrReadRegionAtPoint = async (anchorX, anchorY, options) => {
    const {
      searchRadius = 120 * dRatio,
      ocrScale = 6,
      rotation = 0,
      minConfidence = 30,
      rect = null,
      sharedSheet = null,
      /*
        Oblique (any-angle) passes crop to the dragged box alone, with
        a little bleed: a second window around the anchor would only
        add page frame and neighbouring callouts to a pass whose whole
        job is reading one diagonal callout - slower and worse.

        rowBand drops everything outside the rows that hold glyphs
        before the read - a retry used when the same window read as
        noise (see maskTextBand).
      */
      oblique = false,
      rowBand = false
    } = options;

    if (!pdfPage) return [];

    try {
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      let displayScale = 1;
      if (canvasRef.current) {
        displayScale = canvasRef.current.width / baseViewport.width;
      }

      /* Match or exceed what is on screen, but keep the render
         bounded so heavy zoom does not stall the OCR pass. */
      const scale = Math.min(Math.max(ocrScale, displayScale), 6);

      const fullCanvas = sharedSheet || (await renderOcrPage(scale));

      const ratio = scale / displayScale;
      const margin = 10 * dRatio;

      /*
        A dragged selection crops to that box (plus a little bleed) so
        Tesseract sees the value the operator marked instead of the
        neighbouring dimensions. The box is always UNIONED with the
        usual square around the anchor, so a plain click keeps the old
        window and never loses the tolerance lines stacked below a
        value. Point-only reads behave exactly as before.

        sx / sy are the true source origin of the crop, so the box
        mapping below stays correct even when a clamped window starts
        at 0.
      */
      let cropLeft = anchorX - searchRadius - margin;
      let cropTop = anchorY - searchRadius - margin;
      let cropWidth = searchRadius * 2;
      let cropHeight = searchRadius * 2;

      if (rect && oblique) {
        const bleed = 30 * dRatio;
        cropLeft = Math.min(rect.x1, rect.x2) - bleed;
        cropTop = Math.min(rect.y1, rect.y2) - bleed;
        cropWidth = Math.abs(rect.x1 - rect.x2) + bleed * 2;
        cropHeight = Math.abs(rect.y1 - rect.y2) + bleed * 2;
      } else if (rect) {
        const anchorLeft = anchorX - searchRadius - margin;
        const anchorTop = anchorY - searchRadius - margin;
        const anchorRight = anchorX + searchRadius + margin;
        const anchorBottom = anchorY + searchRadius + margin;

        const rx1 = Math.min(rect.x1, rect.x2) - margin;
        const ry1 = Math.min(rect.y1, rect.y2) - margin;
        const rx2 = Math.max(rect.x1, rect.x2) + margin;
        const ry2 = Math.max(rect.y1, rect.y2) + margin;

        cropLeft = Math.min(anchorLeft, rx1);
        cropTop = Math.min(anchorTop, ry1);
        cropWidth = Math.max(anchorRight, rx2) - cropLeft;
        cropHeight = Math.max(anchorBottom, ry2) - cropTop;
      }

      /*
        Bound the pass: a box dragged across the whole sheet would
        otherwise feed a page-sized bitmap to Tesseract at full
        density and stall the UI. Centre the cap on the anchor, which
        is where the value the user marked lives.
      */
      const maxCrop = 900 * dRatio;

      if (cropWidth > maxCrop) {
        cropLeft = anchorX - maxCrop / 2;
        cropWidth = maxCrop;
      }

      if (cropHeight > maxCrop) {
        cropTop = anchorY - maxCrop / 2;
        cropHeight = maxCrop;
      }

      let sx = cropLeft * ratio;
      let sy = cropTop * ratio;
      let sw = cropWidth * ratio;
      let sh = cropHeight * ratio;

      if (sx < 0) {
        sw += sx;
        sx = 0;
      }
      if (sy < 0) {
        sh += sy;
        sy = 0;
      }

      sw = Math.min(sw, fullCanvas.width - sx);
      sh = Math.min(sh, fullCanvas.height - sy);

      if (sw <= 1 || sh <= 1) return [];

      let crop = document.createElement('canvas');
      crop.width = Math.ceil(sw);
      crop.height = Math.ceil(sh);
      const cropCtx = crop.getContext('2d');
      cropCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

      /* Kept for the inverse mapping: the window before rotation. */
      const cropW0 = crop.width;
      const cropH0 = crop.height;

      /*
        Apply rotation if needed.

        The canvas is grown to the rotated bounding box so a diagonal
        callout is never clipped, and the rotation happens about the
        centre - which is what the inverse mapping below assumes. For
        ±90 the bounding box is simply the swapped width/height, so
        the existing right-angle behaviour is unchanged.
      */
      if (rotation !== 0) {
        const rightAngle =
          Math.abs(Math.abs(rotation) - Math.PI / 2) < 1e-9;
        const absCos = Math.abs(Math.cos(rotation));
        const absSin = Math.abs(Math.sin(rotation));
        const rotCanvas = document.createElement('canvas');
        /* Exact swap at ±90: ceil() would round 995.0000000000001
           up to 996 and shift every rotated reading by half a pixel. */
        rotCanvas.width = rightAngle
          ? crop.height
          : Math.ceil(crop.width * absCos + crop.height * absSin);
        rotCanvas.height = rightAngle
          ? crop.width
          : Math.ceil(crop.width * absSin + crop.height * absCos);
        const rctx = rotCanvas.getContext('2d');
        /* Corners outside the rotated window would otherwise stay
           transparent, which Tesseract reads as black. */
        rctx.fillStyle = '#ffffff';
        rctx.fillRect(0, 0, rotCanvas.width, rotCanvas.height);
        rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
        rctx.rotate(rotation);
        rctx.drawImage(crop, -crop.width / 2, -crop.height / 2);
        crop = rotCanvas;
      }

      /*
        A row-band retry that finds no glyph rows has nothing left to
        read - skip it instead of paying for the same noise twice.
      */
      if (rowBand && !maskTextBand(crop)) return [];

      if (!ocrWorkerRef.current) {
        ocrWorkerRef.current = await createWorker('eng', 1, { 
          workerPath: '/tesseract/worker.min.js', 
          corePath: '/tesseract/tesseract-core.wasm.js', 
          langPath: '/tesseract' 
        });
      }

      /*
        The same bitmap goes to both models at once. English still
        owns every glyph it can read (tolerance stacks, "R10", plain
        numbers), while Danish contributes ONLY the words that carry
        Ø - otherwise its weaker reading of everything else would
        compete with the English one. A Danish Ø word that overlaps
        an English word replaces it, so one callout is never scored
        twice: once as "Ø6" and once as the English substitute "26".
      */
      const danWorker = await getDanWorker();
      const [engResult, danResult] = await Promise.all([
        ocrWorkerRef.current.recognize(crop, {}, { blocks: true }),
        danWorker
          ? danWorker
              .recognize(crop, {}, { blocks: true })
              .catch((error) => {
                console.warn('[DimensionRead] Ø pass failed:', error && error.message);
                return null;
              })
          : Promise.resolve(null)
      ]);

      const words = extractOcrWords(engResult.data);
      const danWords = danResult ? extractOcrWords(danResult.data) : [];

      const mapWordToItem = (word) => {
        if (!word.text || !word.text.trim()) return null;

        let text = normalizeDetectionText(word.text)
          .replace(/O(?=\d)/gi, 'Ø')
          .replace(/^0(?=\d)/, 'Ø');

        if (!isDetectionText(text, { allowLongNumbers: !!rect })) return null;
        if (Number(word.confidence || 0) < minConfidence) return null;

        const wx = word.bbox?.x0 || 0;
        const wy = word.bbox?.y0 || 0;
        const ww = (word.bbox?.x1 - word.bbox?.x0) || 0;
        const wh = (word.bbox?.y1 - word.bbox?.y0) || 0;

        /*
          Map the OCR box back to drawing space.

          `crop` was re-assigned to the rotated canvas, so its
          width/height are the rotated window's - the pre-rotation
          size lives in cropW0/cropH0. Inverting rotate(+90) /
          rotate(-90) therefore looks like this:
            +90 : x = wy,              y = cropH0 - wx - ww
            -90 : x = cropW0 - wy - wh, y = wx
          (the two branches used to be swapped, which mirrored every
          rotated reading and threw the balloon to the wrong spot).

          Any other angle is inverted the same way: the point is taken
          relative to the rotated canvas centre, rotated back by
          -rotation, and put back relative to the original centre.
          The four corners are mapped and their bounding box used, so
          a diagonal word keeps a box that contains it.
        */
        let origX, origY, origW, origH;
        if (rotation === Math.PI / 2) {
          origX = sx / ratio + wy / ratio;
          origY = sy / ratio + (crop.width - wx - ww) / ratio;
          origW = wh / ratio;
          origH = ww / ratio;
        } else if (rotation === -Math.PI / 2) {
          origX = sx / ratio + (crop.height - wy - wh) / ratio;
          origY = sy / ratio + wx / ratio;
          origW = wh / ratio;
          origH = ww / ratio;
        } else if (rotation !== 0) {
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          const rx = crop.width / 2;
          const ry = crop.height / 2;
          const cx0 = cropW0 / 2;
          const cy0 = cropH0 / 2;
          const toOriginal = (X, Y) => {
            const u = X - rx;
            const v = Y - ry;
            return [cx0 + u * cos + v * sin, cy0 - u * sin + v * cos];
          };
          const corners = [
            toOriginal(wx, wy),
            toOriginal(wx + ww, wy),
            toOriginal(wx, wy + wh),
            toOriginal(wx + ww, wy + wh)
          ];
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (const [px, py] of corners) {
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
          origX = sx / ratio + minX / ratio;
          origY = sy / ratio + minY / ratio;
          origW = (maxX - minX) / ratio;
          origH = (maxY - minY) / ratio;
        } else {
          // Normal
          origX = sx / ratio + wx / ratio;
          origY = sy / ratio + wy / ratio;
          origW = ww / ratio;
          origH = wh / ratio;
        }

        return {
          text,
          x: origX,
          y: origY,
          width: origW,
          height: origH,
          confidence: Number(word.confidence || 0),
          source: 'ocr'
        };
      };

      const items = [];
      for (const word of words) {
        const item = mapWordToItem(word);
        if (item) items.push(item);
      }

      /* Share of the smaller box that the two readings cover. */
      const boxOverlap = (a, b) => {
        const w =
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const h =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (w <= 0 || h <= 0) return 0;
        const smaller = Math.min(
          a.width * a.height,
          b.width * b.height
        );
        return smaller > 0 ? (w * h) / smaller : 0;
      };

      for (const word of danWords) {
        if (!word.text || !/[Øø⌀∅]/.test(word.text)) continue;
        if (!/\d/.test(word.text)) continue;

        const item = mapWordToItem(word);
        if (!item) continue;

        for (let i = items.length - 1; i >= 0; i--) {
          if (boxOverlap(item, items[i]) >= 0.4) items.splice(i, 1);
        }
        items.push(item);
      }

      return items;
    } catch (error) {
      console.error('[DimensionRead] OCR region failed:', error);
      return [];
    }
  };

  /* Re-read when a balloon is dropped onto a measurement (legacy wrapper). */
  const readDimensionAtPointLegacy = async (pointX, pointY) => {
    return readDimensionAtPoint(pointX, pointY);
  };

  /* OCR fallback for scanned drawings without a text layer. */

  
const extractOcrWords = (data) => {
  const words = [];
  if (data && data.blocks) {
    data.blocks.forEach(block => {
      if (block.paragraphs) {
        block.paragraphs.forEach(para => {
          if (para.lines) {
            para.lines.forEach(line => {
              if (line.words) {
                words.push(...line.words);
              }
            });
          }
        });
      }
    });
  }
  return words;
};

/*
  Blank every row outside the band that actually holds glyphs.

  Rotating a diagonal callout upright is only half the job: Tesseract
  still has to choose ONE text line out of the picture, and the leader
  line, the dash pattern and the sheet edges that rode along in the
  crop compete with it - the engine locks onto that graphics cluster
  instead and a perfectly legible value comes back as "Ne". A row of
  glyphs carries several short dark runs; a row crossed by a single
  line carries one. Score the rows that way, keep the best cluster
  (padded so no descender is clipped) and white out the rest: the
  canvas keeps its size, so every box mapping downstream is untouched.
*/
const maskTextBand = (canvas) => {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 8 || h < 8) return false;

  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, w, h);
  const maxRun = Math.round(w * 0.3);
  const shortRuns = new Array(h);

  for (let y = 0; y < h; y++) {
    let count = 0;
    let x = 0;
    while (x < w) {
      if (data[(y * w + x) * 4] < 160) {
        const start = x;
        while (x < w && data[(y * w + x) * 4] < 160) x += 1;
        if (x - start <= maxRun) count += 1;
      } else {
        x += 1;
      }
    }
    shortRuns[y] = count;
  }

  /* Smooth over 5 rows so a single stroke gap does not split a line. */
  const smoothed = new Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    let count = 0;
    for (let k = y - 2; k <= y + 2; k++) {
      if (k < 0 || k >= h) continue;
      sum += shortRuns[k];
      count += 1;
    }
    smoothed[y] = count ? sum / count : 0;
  }

  const rows = [];
  for (let y = 0; y < h; y++) if (smoothed[y] >= 3) rows.push(y);
  if (!rows.length) return false;

  const segments = [];
  let start = rows[0];
  let prev = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] - prev > 20) {
      segments.push([start, prev]);
      start = rows[i];
    }
    prev = rows[i];
  }
  segments.push([start, prev]);

  const scored = segments.map(([top, bottom]) => {
    const height = bottom - top + 1;
    let sum = 0;
    for (let y = top; y <= bottom; y++) sum += shortRuns[y];
    return { top, bottom, height, sum };
  });
  /* A band taller than most of the window is a page, not a text line. */
  const plausible = scored.filter((s) => s.height <= h * 0.6);
  const pool = plausible.length ? plausible : scored;
  pool.sort((a, b) => b.sum - a.sum);

  const best = pool[0];
  const pad = Math.max(8, Math.round(best.height * 0.35));
  const top = Math.max(0, best.top - pad);
  const bottom = Math.min(h - 1, best.bottom + pad);

  /* A sliver, or the whole window: masking would only cost a second
     recognition of the same picture. */
  if (bottom - top + 1 < 12) return false;
  if (top === 0 && bottom === h - 1) return false;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, top);
  ctx.fillRect(0, bottom + 1, w, h - bottom - 1);
  return true;
};

  const ocrReadRegion = async (rect) => {
    if (!pdfPage) {
      return [];
    }

    try {
      const baseViewport =
        pdfPage.getViewport({
          scale: 1
        });

      let displayScale = 1;

      if (canvasRef.current) {
        displayScale =
          canvasRef.current.width /
          baseViewport.width;
      }

      const ocrScale = Math.min(Math.max(3.5, displayScale), 6);

      const viewport =
        pdfPage.getViewport({
          scale: ocrScale
        });

      const fullCanvas =
        document.createElement('canvas');

      fullCanvas.width =
        Math.ceil(viewport.width);

      fullCanvas.height =
        Math.ceil(viewport.height);

      const ctx =
        fullCanvas.getContext('2d');

      ctx.filter =
        'grayscale(1) contrast(160%) brightness(105%)';

      await pdfPage.render({
        canvasContext: ctx,
        viewport
      }).promise;

      const margin = 10 * dRatio;
      const ratio = ocrScale / displayScale;

      const sx =
        Math.max(0, (rect.x1 - margin) * ratio);

      const sy =
        Math.max(0, (rect.y1 - margin) * ratio);

      const sw =
        (rect.x2 - rect.x1 + margin * 2) * ratio;

      const sh =
        (rect.y2 - rect.y1 + margin * 2) * ratio;

      if (sw <= 0 || sh <= 0) {
        return [];
      }

      const crop =
        document.createElement('canvas');

      crop.width = Math.ceil(sw);
      crop.height = Math.ceil(sh);

      const cropContext = crop.getContext('2d');

      cropContext.drawImage(
        fullCanvas,
        sx,
        sy,
        sw,
        sh,
        0,
        0,
        sw,
        sh
      );


      let words = [];
      if (!ocrWorkerRef.current) {
        ocrWorkerRef.current = await createWorker('eng', 1, { workerPath: '/tesseract/worker.min.js', corePath: '/tesseract/tesseract-core.wasm.js', langPath: '/tesseract' });
      }

      /*
        Same two-model read as the manual path: English for every glyph
        it can name, Danish only for the words carrying Ø (the English
        alphabet has no such letter), with an overlapping Danish word
        replacing the English substitute for the same callout.
      */
      const danWorker = await getDanWorker();
      const [engResult, danResult] = await Promise.all([
        ocrWorkerRef.current.recognize(crop, {}, { blocks: true }),
        danWorker
          ? danWorker.recognize(crop, {}, { blocks: true }).catch(() => null)
          : Promise.resolve(null)
      ]);

      let { data } = engResult;
      words = extractOcrWords(data).map(w => ({
        text: w.text,
        bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
        confidence: w.confidence
      }));

      if (danResult) {
        const oBoxOverlap = (a, b) => {
          const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (w <= 0 || h <= 0) return 0;
          const smaller = Math.min(
            (a.x1 - a.x0) * (a.y1 - a.y0),
            (b.x1 - b.x0) * (b.y1 - b.y0)
          );
          return smaller > 0 ? (w * h) / smaller : 0;
        };

        for (const w of extractOcrWords(danResult.data)) {
          if (!w.text || !/[Øø⌀∅]/.test(w.text)) continue;
          if (!/\d/.test(w.text)) continue;
          if (Number(w.confidence || 0) < 30) continue;

          const box = {
            x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1
          };
          for (let i = words.length - 1; i >= 0; i--) {
            if (oBoxOverlap(box, words[i].bbox) >= 0.4) words.splice(i, 1);
          }
          words.push({ text: w.text, bbox: box, confidence: w.confidence });
        }
      }

      /* Words that read as a dimension once O -> Ø is repaired. */
      const readableWords = (ws) =>
        ws.some((w) =>
          isDetectionText(
            normalizeDetectionText(w.text)
              .replace(/O(?=\d)/gi, 'Ø')
              .replace(/^0(?=\d)/, 'Ø')
          )
        );

      /*
        One pass at a given rotation: rotate the window (grown to the
        rotated bounding box so a diagonal callout is never clipped),
        optionally keep only the rows holding glyphs (rowBand - a
        retry for windows whose leader lines crowd out the value),
        read it with both models, and map every word box back into
        crop coordinates - the same inverse the manual path uses, so
        ±90 lands on exactly the boxes it always did.
      */
      const readAtAngle = async (rotation, rowBand = false) => {
        let source = crop;

        if (rotation !== 0) {
          const rightAngle =
            Math.abs(Math.abs(rotation) - Math.PI / 2) < 1e-9;
          const absCos = Math.abs(Math.cos(rotation));
          const absSin = Math.abs(Math.sin(rotation));
          const rotCanvas = document.createElement('canvas');
          rotCanvas.width = rightAngle
            ? crop.height
            : Math.ceil(crop.width * absCos + crop.height * absSin);
          rotCanvas.height = rightAngle
            ? crop.width
            : Math.ceil(crop.width * absSin + crop.height * absCos);
          const rctx = rotCanvas.getContext('2d');
          rctx.fillStyle = '#ffffff';
          rctx.fillRect(0, 0, rotCanvas.width, rotCanvas.height);
          rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
          rctx.rotate(rotation);
          rctx.drawImage(crop, -crop.width / 2, -crop.height / 2);
          source = rotCanvas;
        }

        if (rowBand) {
          /* Never mask the shared crop in place - at rotation 0 that
             canvas is the window every other pass still reads. */
          const banded = document.createElement('canvas');
          banded.width = source.width;
          banded.height = source.height;
          banded.getContext('2d').drawImage(source, 0, 0);
          if (!maskTextBand(banded)) return [];
          source = banded;
        }

        const danModel = await getDanWorker();
        const [engRes, danRes] = await Promise.all([
          ocrWorkerRef.current.recognize(source, {}, { blocks: true }),
          danModel
            ? danModel
                .recognize(source, {}, { blocks: true })
                .catch(() => null)
            : Promise.resolve(null)
        ]);

        const backToCrop = (w) => {
          if (rotation === 0) {
            return {
              x0: w.bbox.x0,
              y0: w.bbox.y0,
              x1: w.bbox.x1,
              y1: w.bbox.y1
            };
          }
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          const rx = source.width / 2;
          const ry = source.height / 2;
          const cx0 = crop.width / 2;
          const cy0 = crop.height / 2;
          const corners = [
            [w.bbox.x0, w.bbox.y0],
            [w.bbox.x1, w.bbox.y0],
            [w.bbox.x0, w.bbox.y1],
            [w.bbox.x1, w.bbox.y1]
          ].map(([X, Y]) => {
            const u = X - rx;
            const v = Y - ry;
            return [cx0 + u * cos + v * sin, cy0 - u * sin + v * cos];
          });
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (const [px, py] of corners) {
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
          return { x0: minX, y0: minY, x1: maxX, y1: maxY };
        };

        const pack = (data) =>
          extractOcrWords(data).map((w) => ({
            text: w.text,
            bbox: backToCrop(w),
            confidence: w.confidence
          }));

        const engWords = pack(engRes.data);
        const danWords = danRes ? pack(danRes.data) : [];

        const overlap = (a, b) => {
          const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (w <= 0 || h <= 0) return 0;
          const smaller = Math.min(
            (a.x1 - a.x0) * (a.y1 - a.y0),
            (b.x1 - b.x0) * (b.y1 - b.y0)
          );
          return smaller > 0 ? (w * h) / smaller : 0;
        };

        for (const w of danWords) {
          if (!w.text || !/[Øø⌀∅]/.test(w.text)) continue;
          if (!/\d/.test(w.text)) continue;
          if (Number(w.confidence || 0) < 30) continue;
          for (let i = engWords.length - 1; i >= 0; i--) {
            if (overlap(w.bbox, engWords[i].bbox) >= 0.4) engWords.splice(i, 1);
          }
          engWords.push(w);
        }

        return engWords;
      };

      if (!readableWords(words) && words.length <= 2) {
        const toRad = (deg) => (deg * Math.PI) / 180;
        const dedupe = (angles) => {
          const seen = [];
          for (const angle of angles) {
            if (seen.some((a) => Math.abs(a - angle) < toRad(4))) continue;
            seen.push(angle);
          }
          return seen;
        };

        const tryAngles = async (angles) => {
          for (const rotation of dedupe(angles)) {
            let rotated = await readAtAngle(rotation);
            /* Second look on the same angle: blank everything outside
               the glyph rows, which is what a window full of leader
               lines needs before Tesseract will read the value. */
            if (!readableWords(rotated)) {
              rotated = await readAtAngle(rotation, true);
            }
            if (!readableWords(rotated)) continue;
            words = rotated;
            console.log('[DimensionRead] Auto Detect read at angle:', {
              degrees: Math.round((rotation * 180) / Math.PI)
            });
            return true;
          }
          return false;
        };

        /*
          Straight text first (bottom-to-top, then top-to-bottom), and
          only when both come back empty does the callout get treated
          as a diagonal: a 5 degree grid walked from 45 outwards, each
          angle read twice at most (plain, then glyph rows only). Stop
          at the first read, so drawings with horizontal or vertical
          text never pay for the extra passes.
        */
        let read = await tryAngles([-Math.PI / 2, Math.PI / 2]);

        if (!read) {
          /* 5 degree grid walked from 45° outwards - see the manual
             path for why the grid beat estimating the angle. */
          const sweep = [];
          for (let deg = 5; deg <= 85; deg += 5) {
            if (deg % 90 === 0) continue;
            sweep.push(toRad(deg), toRad(-deg));
          }
          sweep.sort(
            (a, b) =>
              Math.min(Math.abs(a - toRad(45)), Math.abs(a + toRad(45))) -
              Math.min(Math.abs(b - toRad(45)), Math.abs(b + toRad(45)))
          );
          read = await tryAngles(sweep.slice(0, 10));
          if (!read) {
            console.log('[DimensionRead] Auto Detect: no angle readable');
          }
        }
      }

      const items = [];

      for (const word of words) {
        if (!word.text || !word.text.trim()) {
          continue;
        }

        let text = normalizeDetectionText(
          word.text
        )
          .replace(/O(?=\d)/gi, 'Ø')
          .replace(/^0(?=\d)/, 'Ø');

        if (!isDetectionText(text)) {
          continue;
        }

        const wx = word.bbox?.x0 || 0;
        const wy = word.bbox?.y0 || 0;
        const ww =
          (word.bbox?.x1 - word.bbox?.x0) || 0;

        const wh =
          (word.bbox?.y1 - word.bbox?.y0) || 0;

        items.push({
          text,

          x: sx / ratio + wx / ratio,
          y: sy / ratio + wy / ratio,

          width: ww / ratio,
          height: wh / ratio,

          confidence:
            Number(word.confidence || 0),

          source: 'ocr'
        });
      }

      return items;
    } catch (error) {
      console.error(
        'Region OCR failed:',
        error
      );

      return [];
    }
  };

  /* Add Dimension scan: read inside the selected rectangle. */

  
    const analyzeArea = async (rect) => {
        if (!pdfPage) return;
        const minX = Math.min(rect.x1, rect.x2);
        const maxX = Math.max(rect.x1, rect.x2);
        const minY = Math.min(rect.y1, rect.y2);
        const maxY = Math.max(rect.y1, rect.y2);

        let detected = [];
        
        try {
            const viewport = pdfPage.getViewport({ scale: 1 });
            const textContent = await pdfPage.getTextContent();
            let displayScale = 1;
            if (canvasRef.current) displayScale = canvasRef.current.width / viewport.width;

            for (const item of textContent.items) {
                if (!item.str || !item.str.trim()) continue;
                
                // Convert PDF coordinate to Canvas space
                const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
                const itemX = tx[4] * displayScale;
                const itemY = tx[5] * displayScale;
                const itemW = item.width * displayScale;
                const itemH = item.height * displayScale;
                const centerX = itemX + itemW / 2;
                const centerY = itemY - itemH / 2;

                if (centerX >= minX && centerX <= maxX && centerY >= minY && centerY <= maxY) {
                    detected.push({
                        text: item.str.trim(),
                        x: itemX,
                        y: itemY,
                        width: itemW,
                        height: itemH,
                        confidence: 100,
                        source: 'pdf'
                    });
                }
            }
        } catch (e) {
            console.error("PDF text extraction failed", e);
        }

        const hasValidPdfText = detected.some(item => detectPatterns(item.text) !== null);

        if (!hasValidPdfText && typeof ocrReadRegion === 'function') {
            try {
                const ocrItems = await ocrReadRegion(rect);
                // ocrReadRegion already returns coordinates in absolute Canvas Space (sx / ratio applied internally).
                // So we just map them directly into our detected array!
                for (const item of ocrItems) {
                    detected.push({
                        text: item.text.trim(),
                        x: item.x,
                        y: item.y,
                        width: item.width,
                        height: item.height,
                        confidence: item.confidence || 80,
                        source: 'ocr'
                    });
                }
            } catch (e) {
                console.error("OCR fallback failed", e);
            }
        }

        let finalDetected = clusterDetectionsIntoDimensions(detected);

        finalDetected = finalDetected.map(item => {
            const match = detectPatterns(item.text);
            if (match) {
                return { ...item, type: match.type, specification: item.text, confidence: 100 };
            }
            return item;
        }).filter(item => detectPatterns(item.text) !== null);

        setPreviewDetections(finalDetected);
    };

  const scanDimensionInRect = async (rect) => {
    if (!pdfPage) {
      return null;
    }

    const items =
      await collectDimensionItems();

    if (items.length > 0) {
      const centerX =
        (rect.x1 + rect.x2) / 2;

      const centerY =
        (rect.y1 + rect.y2) / 2;

      let target = null;

      // Prefer a real dimension value over a lone
      // tolerance like "0.05" when both sit inside the box.
      const hasBaseValue = (item) =>
        !DETECTION_PATTERNS.smallTolerance.test(
          item.text
        );

      const inside = items
        .filter((item) => {
          const itemLeft = item.x;
          const itemRight = item.x + (item.width || 0);
          const itemTop = item.source === 'ocr' ? item.y : item.y - (item.height || 0);
          const itemBottom = item.source === 'ocr' ? item.y + (item.height || 0) : item.y;
          
          const intersects = !(itemLeft > rect.x2 || itemRight < rect.x1 || itemTop > rect.y2 || itemBottom < rect.y1);
          const itemX = detectionCenterX(item);
          const itemY = detectionCenterY(item);
          const centerInside = (itemX >= rect.x1 && itemX <= rect.x2 && itemY >= rect.y1 && itemY <= rect.y2);

          return intersects || centerInside;
        })
        .sort((a, b) => {
          const distanceA = Math.hypot(
            detectionCenterX(a) - centerX,
            detectionCenterY(a) - centerY
          );

          const distanceB = Math.hypot(
            detectionCenterX(b) - centerX,
            detectionCenterY(b) - centerY
          );

          if (
            hasBaseValue(a) !==
            hasBaseValue(b)
          ) {
            return hasBaseValue(a) ? -1 : 1;
          }

          return distanceA - distanceB;
        });

      if (inside.length > 0) {
        // Sort geographically for reading order: top-to-bottom, left-to-right
        inside.sort((a, b) => {
          if (Math.abs(a.y - b.y) > 5 * dRatio) return a.y - b.y;
          return a.x - b.x;
        });
        const combinedText = inside.map(i => i.text).join(' ');
        target = {
          ...inside[0],
          text: combinedText
        };
      } else {
        target = findNearestDimension(
          items,
          centerX,
          centerY,
          70 * dRatio
        );
      }

      if (target) {
        let pdfResult = {
          ...parseNearestDimension(items, target),
          source: 'pdf',
          confidence: 1
        };

        /*
          CAD PDFs often draw symbols (like Ø) as vector graphics while
          keeping the number as text. Inspect the pixel slot before the
          matching number and attach Ø when a ring glyph is present.
        */
        pdfResult = await attachGeometryDiameter(
          pdfResult,
          items,
          centerX,
          centerY
        );

        /* Skip OCR noise and tolerance-only readings - they would
           otherwise become the stored value for this balloon. */
        if (isReadableCallout(pdfResult)) {
          return pdfResult;
        }
      }
    }

    const ocrItems =
      await ocrReadRegion(rect);

    if (ocrItems.length > 0) {
      const centerX = (rect.x1 + rect.x2) / 2;
      const centerY = (rect.y1 + rect.y2) / 2;

      // Filter OCR items that are geometrically inside the rectangle
      const inside = ocrItems.filter((item) => {
        const itemLeft = item.x;
        const itemRight = item.x + (item.width || 0);
        const itemTop = item.y;
        const itemBottom = item.y + (item.height || 0);
        const intersects = !(itemLeft > rect.x2 || itemRight < rect.x1 || itemTop > rect.y2 || itemBottom < rect.y1);
        const itemX = detectionCenterX(item);
        const itemY = detectionCenterY(item);
        const centerInside = (itemX >= rect.x1 && itemX <= rect.x2 && itemY >= rect.y1 && itemY <= rect.y2);
        return intersects || centerInside;
      });

      let target = null;
      if (inside.length > 0) {
        inside.sort((a, b) => {
          if (Math.abs(a.y - b.y) > 5 * dRatio) return a.y - b.y;
          return a.x - b.x;
        });
        const combinedText = inside.map(i => i.text).join(' ');
        target = { ...inside[0], text: combinedText };
      } else {
        target = findNearestDimension(ocrItems, centerX, centerY, 90 * dRatio);
      }

      if (target) {
        const ocrResult = {
          ...parseNearestDimension(ocrItems, target),
          source: 'ocr',
          confidence: target.confidence
        };

        if (isReadableCallout(ocrResult)) {
          return ocrResult;
        }
      }
    }

    return null;
  };

  /* =========================================================
     UPLOAD DRAWING
  ========================================================= */

  const uploadDrawing = async (
    event
  ) => {
    const selected =
      event.target.files?.[0];

    if (!selected) return;

    if (
      !selected.name
        .toLowerCase()
        .endsWith('.pdf') &&
      !selected.type.includes('pdf')
    ) {
      setMessage(
        'Please select a PDF drawing'
      );
      return;
    }

    try {
      setUploading(true);
      setMessage(
        'Uploading drawing...'
      );

      const formData =
        new FormData();

      formData.append(
        'drawing',
        selected
      );

      const data =
        await api.upload(
          `/projects/${id}/drawing`,
          formData
        );

      const drawingEntry = {
        ...data,
        url:
          data.filePath ||
          data.url
      };

      setDrawings((prev) => [
        drawingEntry,
        ...prev
      ]);

      setSelectedDrawingId(
        drawingEntry._id
      );

      setMessage(
        'Drawing uploaded successfully'
      );
    } catch (error) {
      console.error(error);

      setMessage(
        error.message ||
        'Drawing upload failed'
      );
    } finally {
      setUploading(false);

      event.target.value = '';
    }
  };

  /* =========================================================
     DELETE DRAWING
  ========================================================= */

  const deleteDrawing = async (
    drawingId
  ) => {
    if (!drawingId) return;

    try {
      await api.delete(
        `/projects/${id}/drawings/${drawingId}`
      );

      setDrawings((prev) => {
        const remaining =
          prev.filter(
            (item) =>
              item._id !== drawingId
          );

        if (
          selectedDrawingId ===
          drawingId
        ) {
          setSelectedDrawingId(
            remaining.length > 0
              ? remaining[0]._id
              : null
          );
        }

        return remaining;
      });

      setConfirmDeleteDrawingId(
        null
      );

      setActiveDrawingMenuId(
        null
      );

      setMessage(
        'Drawing deleted'
      );
    } catch (error) {
      setMessage(
        error.message ||
        'Failed to delete drawing'
      );
    }
  };

  /* =========================================================
     RENAME DRAWING
  ========================================================= */

  const renameDrawing = async (
    drawingId,
    newName
  ) => {
    if (
      !drawingId ||
      !newName
    ) {
      return;
    }

    try {
      const updated =
        await api.put(
          `/projects/${id}/drawings/${drawingId}`,
          {
            fileName: newName
          }
        );

      setDrawings((prev) =>
        prev.map((item) =>
          item._id ===
            updated._id
            ? {
              ...updated,
              url:
                updated.filePath ||
                updated.url
            }
            : item
        )
      );

      setActiveDrawingMenuId(
        null
      );

      setMessage(
        'Drawing renamed'
      );
    } catch (error) {
      setMessage(
        error.message ||
        'Rename failed'
      );
    }
  };

  /* =========================================================
     PAGE NAVIGATION
  ========================================================= */

  const previousPage = () => {
    setPageNumber((page) =>
      Math.max(1, page - 1)
    );
  };

  const nextPage = () => {
    setPageNumber((page) =>
      Math.min(
        pageCount,
        page + 1
      )
    );
  };

  /* =========================================================
   SMART DETECTION CLEANUP
   ---------------------------------------------------------
   Removes duplicate readings and joins nearby tolerance
   text with its parent dimension.
========================================================= */

  const cleanAndGroupDetections = (detections) => {
    if (!detections || detections.length === 0) {
      return [];
    }

    const normalize = (value) =>
      String(value || '')
        .replace(/[−–—]/g, '-')
        .replace(/[＋]/g, '+')
        .replace(/[Øø]/g, 'Ø')
        .replace(/(\d),(\d)/g, '$1.$2')
        .replace(/\s+/g, ' ')
        .trim();

    const getNumber = (text) => {
      const match = normalize(text).match(
        /(?:Ø\s*|R\s*)?(\d+(?:\.\d+)?)/i
      );

      return match ? match[1] : null;
    };

    const isToleranceOnly = (text) => {
      const value = normalize(text);

      return (
        /^(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^[+]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^[+-]?\s*0?\.\d{1,3}$/i.test(value)
      );
    };

    const isFullTolerance = (text) => {
      const value = normalize(text);

      return (
        /^\d+(?:\.\d+)?\s*(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^\d+(?:\.\d+)?\s*[+＋]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?$/i.test(value)
      );
    };

    const isDimension = (text) => {
      const value = normalize(text);

      return (
        /^Ø\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^R\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^\d+(?:\.\d+)?(?:\s*(?:mm|in|inch|inches))?$/i.test(value)
      );
    };

    const center = (item) => ({
      x:
        Number(item.x || 0) +
        Number(item.width || 0) / 2,

      y:
        Number(item.y || 0) +
        Number(item.height || 0) / 2
    });

    const distance = (a, b) => {
      const ca = center(a);
      const cb = center(b);

      return Math.sqrt(
        Math.pow(ca.x - cb.x, 2) +
        Math.pow(ca.y - cb.y, 2)
      );
    };

    const sameLocation = (a, b) => {
      const d = distance(a, b);

      const sizeA = Math.max(
        Number(a.width || 0),
        Number(a.height || 0),
        10
      );

      const sizeB = Math.max(
        Number(b.width || 0),
        Number(b.height || 0),
        10
      );

      return d <= Math.max(12, Math.min(sizeA, sizeB) * 1.8);
    };

    /*
       STEP 1
       Normalize all text.
    */

    const normalized = detections
      .map((item) => ({
        ...item,
        text: normalize(item.text)
      }))
      .filter((item) => item.text);

    /*
       STEP 2
       Remove exact duplicate readings that are
       physically at the same location.
    */

    const unique = [];

    for (const item of normalized) {
      const duplicate = unique.some((existing) => {
        return (
          normalize(existing.text) ===
          normalize(item.text) &&
          sameLocation(existing, item)
        );
      });

      if (!duplicate) {
        unique.push(item);
      }
    }

    /*
       STEP 3
       Join tolerance-only text with the nearest
       dimension.
  
       Example:
  
         25
         ±0.05
  
       becomes:
  
         25 ±0.05
  
       Instead of two balloons.
    */

    const used = new Set();
    const grouped = [];

    for (let i = 0; i < unique.length; i++) {
      if (used.has(i)) {
        continue;
      }

      const current = unique[i];

      /*
         If this is already a complete reading,
         keep it as one characteristic.
      */

      if (isFullTolerance(current.text)) {
        grouped.push(current);
        used.add(i);
        continue;
      }

      /*
         If this is a normal dimension, search
         for a nearby tolerance.
      */

      if (isDimension(current.text)) {
        let bestToleranceIndex = -1;
        let bestDistance = Infinity;

        for (let j = 0; j < unique.length; j++) {
          if (i === j || used.has(j)) {
            continue;
          }

          const candidate = unique[j];

          if (!isToleranceOnly(candidate.text)) {
            continue;
          }

          const d = distance(
            current,
            candidate
          );

          /*
             Tolerance should be physically close
             to the dimension.
  
             The 45px value is deliberately limited
             so unrelated dimensions don't merge.
          */

          if (d < 45 * dRatio && d < bestDistance) {
            bestDistance = d;
            bestToleranceIndex = j;
          }
        }

        if (bestToleranceIndex !== -1) {
          const tolerance =
            unique[bestToleranceIndex];

          let toleranceText =
            normalize(tolerance.text);

          /*
             Convert:
  
             0.02
  
             into:
  
             ±0.02
  
             ONLY when it is clearly attached
             to a dimension.
          */

          if (
            /^0?\.\d{1,3}$/i.test(
              toleranceText
            )
          ) {
            toleranceText =
              `±${toleranceText}`;
          }

          grouped.push({
            ...current,

            text:
              `${current.text} ${toleranceText}`,

            width:
              Math.max(
                Number(current.width || 0),
                Number(tolerance.width || 0)
              ),

            height:
              Math.max(
                Number(current.height || 0),
                Number(tolerance.height || 0)
              )
          });

          used.add(i);
          used.add(bestToleranceIndex);

          continue;
        }
      }

      /*
         Otherwise keep the original detection.
      */

      grouped.push(current);
      used.add(i);
    }

    /*
       STEP 4
       Final safety check.
  
       Never allow two characteristics to
       occupy essentially the same location.
    */

    const finalResult = [];

    for (const item of grouped) {
      const duplicate = finalResult.some(
        (existing) => {
          if (
            normalize(existing.text) ===
            normalize(item.text)
          ) {
            return sameLocation(
              existing,
              item
            );
          }

          /*
             If two different OCR readings are
             almost exactly on top of each other,
             keep only one.
          */

          return distance(
            existing,
            item
          ) < 8;
        }
      );

      if (!duplicate) {
        finalResult.push(item);
      }
    }

    return finalResult;
  };

  /* =========================================================
   AUTO DETECTION
   Detect engineering dimensions + grouped tolerances

   SUPPORTED:
   ---------------------------------------------------------
   1. 25
   2. Ø20
   3. R10
   4. 25 ±0.05
   5. 25 +0.05/-0.03
   6. 25
        +0.05
        -0.03

   IMPORTANT:
   Nearby tolerance values are grouped with the
   main dimension and DO NOT create separate balloons.
========================================================= */

  const autoDetect = async () => {
    if (!pdfPage) {
      setMessage('Please upload a PDF first');
      return;
    }

    if (autoDetectDoneRef.current && !roiRect) {
      setMessage(
        'Detection already complete. Select an area first (using "Select Area") to detect a different part, or use "Clear All Ballooning" to start over.'
      );
      return;
    }

    try {
      setAutoDetecting(true);
      setMode('auto');

      setMessage('Analyzing engineering drawing...');

      /* =========================================================
         1. PDF PAGE INFORMATION
      ========================================================= */

      const baseViewport = pdfPage.getViewport({
        scale: 1
      });

      let displayScale = 1;

      if (canvasRef.current) {
        displayScale =
          canvasRef.current.width /
          baseViewport.width;
      }

      /* =========================================================
         2. DETECTION REGEX
      ========================================================= */

      const tolerancePattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:Ø\s*)?\d+(?:\.\d+)?(?:\s*[A-Za-z0-9]+)*\s*(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const bilateralTolerancePattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:Ø\s*)?\d+(?:\.\d+)?(?:\s*[A-Za-z0-9]+)*\s*[+＋]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const unilateralTolerancePattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:Ø\s*)?\d+(?:\.\d+)?\s*[+＋\-−]\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const diameterPattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:C\/BORE\s*)?Ø\s*\d+(?:\.\d+)?(?:(?:\s*[x×]\s*\d+(?:\.\d+)?)?(?:\s*DP)?)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const radiusPattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:SR|CR)?\s*R\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const dimensionPattern =
        /^\s*(?:\d+[Xx*]\s*)?\d+(?:\.\d+)?(?:\s*(?:mm|in|inch|inches))?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const fitPattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:Ø\s*)?\d+(?:\.\d+)?\s*[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?(?:\s*(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?)?(?:\s*[+＋]\s*\d+(?:\.\d+)?\s*\/?\s*[-−]?\s*\d+(?:\.\d+)?)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const anglePattern =
        /^\s*(?:\d+[Xx*]\s*)?\d+(?:\.\d+)?\s*°\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const angleTolerancePattern =
        /^\s*(?:\d+[Xx*]\s*)?\d+(?:\.\d+)?\s*°\s*±\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const angularToleranceLinePattern =
        /^\s*±\s*\d+(?:\.\d+)?\s*°\s*$/i;

      const bareFitPattern =
        /^\s*[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?\s*$/i;

      const threadPattern =
        /^\s*(?:\d+[Xx*]\s*)?M\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const datumFeaturePattern =
        /^\s*\d+(?:\.\d+)?\s*[A-Z]\s*$/i;

      /*
        Standalone small tolerance.
      */
      const smallTolerancePattern =
        /^\s*[+-±]?\s*0?\.\d{1,3}\s*$/;

      /* =========================================================
         3. NORMALIZE TEXT
      ========================================================= */

      const normalizeText = (value) => {
        return String(value || '')
          .replace(/[−–—]/g, '-')
          .replace(/[＋]/g, '+')
          .replace(/[Øø]/g, 'Ø')
          .replace(/^[OQo](?=\d)/, 'Ø') // Fix O/Q misread as diameter
          .replace(/^0(?=[1-9])/, 'Ø') // Fix 0 misread as diameter (022 -> Ø22)
          .replace(/(\d),(\d)/g, '$1.$2')
          .replace(/\s+/g, ' ')
          .replace(/\s*\.\s*/g, '.') // Remove spaces around decimal
          .replace(/\s*\+\s*/g, '+') // Remove spaces around plus
          .replace(/\s*\-\s*/g, '-') // Remove spaces around minus
          .replace(/\s*±\s*/g, '±') // Remove spaces around plus/minus
          .replace(/\s*\/\s*/g, '/') // Remove spaces around slash
          .trim();
      };

      /* =========================================================
         4. CHARACTERISTIC CHECK
      ========================================================= */

      const isCharacteristicText = (rawText) => {
        const text = normalizeText(rawText);

        if (!text) {
          return false;
        }

        /*
          Ignore obvious non-dimension text.
        */

        if (
          /^(A[0-4]|REV|DATE|DESCRIPTION|WEIGHT|SHEET|SCALE)$/i.test(
            text
          )
        ) {
          return false;
        }

        /*
          Ignore dates.
        */

        if (
          /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(
            text
          )
        ) {
          return false;
        }

        /*
          Ignore drawing / part numbers.
        */

        if (
          /\d+[-_/]\d+[-_/]\d+/.test(text)
        ) {
          return false;
        }

        /*
          Ignore long numbers.
        */

        if (
          /^\d{4,}$/.test(text)
        ) {
          return false;
        }

        /*
          Accept engineering characteristics.
        */

        if (
          tolerancePattern.test(text) ||
          bilateralTolerancePattern.test(text) ||
          unilateralTolerancePattern.test(text) ||
          diameterPattern.test(text) ||
          radiusPattern.test(text) ||
          dimensionPattern.test(text) ||
          smallTolerancePattern.test(text) ||
          fitPattern.test(text) ||
          anglePattern.test(text) ||
          angleTolerancePattern.test(text) ||
          angularToleranceLinePattern.test(text) ||
          bareFitPattern.test(text) ||
          threadPattern.test(text) ||
          datumFeaturePattern.test(text)
        ) {
          return true;
        }

        return false;
      };

      /* =========================================================
         4.5 DETECT GARBLED / CUSTOM-ENCODED FONTS
         ---------------------------------------------------------
         Some engineering PDFs use custom font encodings where
         characters are shifted (e.g. by 29 positions). This makes
         the PDF text layer unreadable. If we detect this, we skip
         the text layer entirely and go straight to OCR.
      ========================================================= */

      const textContent =
        await pdfPage.getTextContent();

      const detected = [];
      const allTextItems = [];

      console.log('=== AUTO-DETECT DEBUG ===');
      console.log('Total PDF text items:', textContent.items.length);

      const nonEmptyItems = textContent.items.filter(
        (item) => item.str && item.str.trim()
      );

      let garbledCount = 0;

      for (const item of nonEmptyItems) {
        const str = item.str.trim();
        let controlChars = 0;

        for (let i = 0; i < str.length; i++) {
          const code = str.charCodeAt(i);
          // Control characters: ASCII 0-31 (excluding tab=9, newline=10, carriage return=13)
          if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
            controlChars++;
          }
        }

        // If more than 30% of the characters in this item are control chars, it's garbled
        if (controlChars / str.length > 0.3) {
          garbledCount++;
        }
      }

      const isGarbledPDF =
        nonEmptyItems.length > 0 &&
        garbledCount / nonEmptyItems.length > 0.4;

      console.log(
        'Garbled font check:',
        garbledCount, 'of', nonEmptyItems.length,
        'items have control chars. isGarbled =', isGarbledPDF
      );

      /* =========================================================
         5. READ SELECTABLE PDF TEXT (skip if garbled)
      ========================================================= */

      if (!isGarbledPDF) {
        for (
          const item of textContent.items
        ) {
          if (
            !item.str ||
            !item.str.trim()
          ) {
            continue;
          }

          const pdfX = item.transform?.[4] || 0;
          const pdfY = item.transform?.[5] || 0;
          const point = baseViewport.convertToViewportPoint(pdfX, pdfY);
          const x = point[0] * displayScale;
          const y = point[1] * displayScale;
          const width = Number(item.width || 0) * displayScale;
          const height = Number(item.height || 0) * displayScale;

          const vt = baseViewport.transform;
          const tr = item.transform || [1, 0, 0, 1, 0, 0];

          const mat = [
            (vt[0] * tr[0] + vt[2] * tr[1]) * displayScale,
            (vt[1] * tr[0] + vt[3] * tr[1]) * displayScale,
            (vt[0] * tr[2] + vt[2] * tr[3]) * displayScale,
            (vt[1] * tr[2] + vt[3] * tr[3]) * displayScale
          ];

          allTextItems.push({
            text: item.str.trim(),
            x, y, width, height,
            mat,
            source: 'pdf',
            centerX: x + width / 2,
            centerY: y + height / 2
          });

          const text = normalizeText(item.str);

          // Only filter out pure text blocks without numbers
          const passes = /\d/.test(text);
          if (!passes) {
            console.log('REJECTED (no digits):', JSON.stringify(text));
            continue;
          }



          console.log('ACCEPTED:', JSON.stringify(text), 'at', Math.round(x), Math.round(y));

          detected.push({
            text,
            x,
            y,

            width:
              Number(item.width || 0) *
              displayScale,

            height:
              Number(item.height || 0) *
              displayScale,

            confidence: 1,

            source: 'pdf'
          });
        }
      } else {
        console.log('PDF text layer is garbled (custom font encoding). Skipping to OCR...');
      }

      /* =========================================================
         6. REMOVE DUPLICATE / OVERLAPPING DETECTIONS
      ========================================================= */

      console.log('Total ACCEPTED before dedup:', detected.length);

      /* =========================================================
         7. OCR FALLBACK
      ========================================================= */
      
      const uniqueDetected = cleanAndGroupDetections(detected);
      let finalDetected = uniqueDetected;

      if (isGarbledPDF || detected.length < 10) {
        setMessage('Scanning vector shapes and vertical text...');

        try {
          const ocrScale = Math.min(Math.max(4, displayScale), 6);
          const ocrViewport = pdfPage.getViewport({ scale: ocrScale });
          const ocrCanvas = document.createElement('canvas');
          const ocrContext = ocrCanvas.getContext('2d');
          ocrCanvas.width = Math.ceil(ocrViewport.width);
          ocrCanvas.height = Math.ceil(ocrViewport.height);
          
          ocrContext.filter = 'grayscale(1) blur(0.4px) contrast(175%) brightness(107%)';
          await pdfPage.render({ canvasContext: ocrContext, viewport: ocrViewport }).promise;

          if (!ocrWorkerRef.current) {
            ocrWorkerRef.current = await createWorker('eng', 1, { workerPath: '/tesseract/worker.min.js', corePath: '/tesseract/tesseract-core.wasm.js', langPath: '/tesseract' });
          }
          await ocrWorkerRef.current.setParameters({
            tessedit_pageseg_mode: '11'
          });

          const recognizePass = async (psm) => {
            await ocrWorkerRef.current.setParameters({ tessedit_pageseg_mode: String(psm) });
            const r = await ocrWorkerRef.current.recognize(ocrCanvas, {}, { blocks: true });
            return extractOcrWords(r.data) || [];
          };
          const sameSpot = (a, b) => {
            const d = Math.hypot(
              (a.bbox.x0 + a.bbox.x1) / 2 - (b.bbox.x0 + b.bbox.x1) / 2,
              (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2
            );
            const sa = Math.max(a.bbox.x1 - a.bbox.x0, a.bbox.y1 - a.bbox.y0, 1);
            const sb = Math.max(b.bbox.x1 - b.bbox.x0, b.bbox.y1 - b.bbox.y0, 1);
            return d <= Math.max(14, Math.min(sa, sb) * 1.6);
          };

          /*
            Two page-segmentation modes: sparse text finds most labels,
            the uniform-block pass picks up dims tucked between dense
            extension lines. Dedupe so nothing is counted twice.
          */
          let words = await recognizePass(11);
          for (const extra of await recognizePass(6)) {
            if (!words.some(w => String(w.text || '').trim() === String(extra.text || '').trim() && sameSpot(w, extra))) {
              extra.__pass2 = true;
              words.push(extra);
            }
          }
          await ocrWorkerRef.current.setParameters({ tessedit_pageseg_mode: '11' });

          const ocrDetected = [];
          for (const word of words) {
            if (!word.text || !word.text.trim()) continue;
            let text = word.text;
            
            const x = (word.bbox.x0 / ocrScale) * displayScale;
            const y = (word.bbox.y0 / ocrScale) * displayScale;
            const width = ((word.bbox.x1 - word.bbox.x0) / ocrScale) * displayScale;
            const height = ((word.bbox.y1 - word.bbox.y0) / ocrScale) * displayScale;
            
            /*
              Second-pass words are detection candidates only - they
              are noisier, and feeding them into the page-context
              model makes the table/grid filter reject real view
              dimensions.
            */
            if (!word.__pass2) {
              allTextItems.push({
                text: word.text.trim(),
                x, y, width, height,
                centerX: x + width / 2,
                centerY: y + height / 2
              });
            }

            if (!/\d/.test(text)) continue;

            ocrDetected.push({
              text,
              x,
              y,
              width: ((word.bbox.x1 - word.bbox.x0) / ocrScale) * displayScale,
              height: ((word.bbox.y1 - word.bbox.y0) / ocrScale) * displayScale,
              confidence: word.confidence,
              source: 'ocr'
            });
          }

          finalDetected =
            cleanAndGroupDetections(
              [
                ...finalDetected,
                ...ocrDetected
              ]
            );

        } catch (ocrError) {
          console.error(
            'OCR failed:',
            ocrError
          );

          setMessage(
            'OCR failed. Please use a clearer drawing.'
          );

          return;
        }
      }

      /* =========================================================
         8. CHECK RESULT
      ========================================================= */

      if (
        finalDetected.length === 0
      ) {
        setMessage(
          'No engineering dimensions or tolerances were detected.'
        );

        return;
      }

      if (roiRect) {
          /* The box is stored page-relative; convert back to the
             current canvas pixels so the filter matches whatever
             zoom level detection runs at. */
          const roi = roiRectToCanvas(roiRect);
          const minX = Math.min(roi.x1, roi.x2);
          const maxX = Math.max(roi.x1, roi.x2);
          const minY = Math.min(roi.y1, roi.y2);
          const maxY = Math.max(roi.y1, roi.y2);

          finalDetected = finalDetected.filter(item => {
             const centerX = item.x + item.width / 2;
             const centerY = item.y + item.height / 2;
             return centerX >= minX && centerX <= maxX &&
                    centerY >= minY && centerY <= maxY;
          });
        }

        let limited = enhanceDetections(finalDetected, baseViewport.width * displayScale, baseViewport.height * displayScale, dRatio);
      limited = contextualFilter(limited, allTextItems, baseViewport.width * displayScale, baseViewport.height * displayScale, dRatio);

      /* =========================================================
         10.5 ATTACH VECTOR DIAMETER SYMBOLS
         ---------------------------------------------------------
         Ø is frequently drawn as vector art, so the text layer
         only contains the number. For every accepted candidate
         without a symbol, inspect the pixel slot before the
         matching number and force the Ø symbol when a ring glyph
         is present.
      ========================================================= */

      if (!isGarbledPDF && limited.length > 0) {
        const pdfRaw = allTextItems.filter(
          (t) => t.mat && t.source === 'pdf' && /\d/.test(t.text)
        );

        for (const item of limited) {
          try {
            if (
              item.type === 'Angle' ||
              item.type === 'Thread' ||
              item.type === 'Radius'
            ) {
              continue;
            }

            const currentValue = String(item.value || item.text || '');

            if (/^(SØ|SR|R|M)/i.test(currentValue.trim())) continue;

            /*
              Multi-line groups ("10 5.5") can mangle the parsed
              value, so try every number in spec + value, in
              order, until a geometric Ø is confirmed.
              Tolerance-only numbers (0.05) are filtered per
              number below.
            */
            const numbers = [];
            const numRe = /\d+(?:\.\d+)?/g;
            const sourceText = `${item.specification || ''} ${currentValue}`;
            let numMatch;
            while ((numMatch = numRe.exec(sourceText))) {
              const n = numMatch[0];
              if (
                !numbers.includes(n) &&
                !DETECTION_PATTERNS.smallTolerance.test(n)
              ) {
                numbers.push(n);
              }
            }
            if (numbers.length === 0) continue;

            const itemCenterX =
              item.centerX != null ? item.centerX : detectionCenterX(item);
            const itemCenterY =
              item.centerY != null ? item.centerY : detectionCenterY(item);

            for (const num of numbers) {
              const near = pdfRaw
                .filter((t) => {
                  const m = String(t.text).match(/^\s*(\d+(?:\.\d+)?)/);
                  if (!m || Number(m[1]) !== Number(num)) return false;

                  return (
                    Math.hypot(
                      detectionCenterX(t) - itemCenterX,
                      detectionCenterY(t) - itemCenterY
                    ) < 120 * dRatio
                  );
                })
                .sort(
                  (a, b) =>
                    Math.hypot(
                      detectionCenterX(a) - itemCenterX,
                      detectionCenterY(a) - itemCenterY
                    ) -
                    Math.hypot(
                      detectionCenterX(b) - itemCenterX,
                      detectionCenterY(b) - itemCenterY
                    )
                );

              if (near.length === 0) {
                if (window.__slotDebug) {
                  console.log(
                    '[diameter-detect] no pdf item for', num,
                    'near', Math.round(itemCenterX) + ',' + Math.round(itemCenterY)
                  );
                }
                continue;
              }
              if (!(await detectDiameterSymbol(near[0]))) continue;

              const origSpec = String(
                item.specification || item.text || ''
              );
              const merged = normalizeCallout({
                specification: origSpec,
                value: num,
                plusTolerance: item.plusTolerance,
                minusTolerance: item.minusTolerance,
                type: 'Diameter'
              });

              if (merged) {
                const qtyM = currentValue.match(
                  /^\s*([1-9]\d*)\s*[x×]\s+/i
                );
                let newSpec;
                let newVal = String(merged.value || '');

                /*
                  Quantity rows and stacked split parts keep the
                  original note text ("2 × 5.5 THRU ALL",
                  "3 x 4.2 12") with only the Ø symbol injected -
                  normalizeCallout rebuilds the spec from the bare
                  number and would drop quantity, depth and THRU
                  wording.
                */
                if (
                  (item.splitPart || qtyM) &&
                  origSpec.includes(num) &&
                  !/[\u00d8\u2300]/.test(origSpec)
                ) {
                  newSpec = origSpec.replace(
                    new RegExp(
                      `(^|[^\\d.])(${num.replace(/\./g, '\\.')})(?![\\d.])`
                    ),
                    '$1\u00d8 $2'
                  );
                } else {
                  newSpec = String(merged.specification || '');
                  if (qtyM && !newSpec.includes(qtyM[1])) {
                    newSpec = `${qtyM[1]} X ${newSpec}`;
                  }
                }

                /*
                  Keep the quantity prefix ("3 × 4.2 12" ->
                  "3 X Ø 4.2") - otherwise the rebuilt value
                  would lose it.
                */
                if (qtyM && !newVal.includes(qtyM[1])) {
                  newVal = `${qtyM[1]} X ${newVal}`;
                }

                Object.assign(item, merged, {
                  specification: newSpec,
                  value: newVal,
                  text: newSpec
                });
                console.log(
                  '[diameter-detect] auto Ø before',
                  num,
                  '->',
                  newVal
                );
              }
              break;
            }
          } catch (error) {
            console.warn('[diameter-detect] auto failed:', error);
          }
        }
      }

      /* =========================================================
         11. CHECK GROUPED RESULT
      ========================================================= */

      if (
        limited.length === 0
      ) {
        setMessage(
          'No usable engineering characteristics were detected.'
        );

        return;
      }

      /* =========================================================
         12. FIND NEXT BALLOON NUMBER
      ========================================================= */

      let currentMaxNumber = 0;

      displayedBalloons.forEach(
        (balloon) => {
          const number =
            Number(
              balloon.number
            );

          if (
            Number.isFinite(
              number
            ) &&
            number >
            currentMaxNumber
          ) {
            currentMaxNumber =
              number;
          }
        }
      );

      /* =========================================================
         13. CREATE BALLOONS + CHARACTERISTICS
      ========================================================= */

      const metrics = canvasMetrics();

      let createdCount = 0;

      for (
        const item of limited
      ) {
        try {
          /*
            Increment only ONCE.
  
            Tolerances no longer receive
            separate balloon numbers.
          */

          currentMaxNumber += 1;

          const nextNumber =
            currentMaxNumber;

          /* =====================================================
             BALLOON + VALUE POSITIONS
             -----------------------------------------------------
             The balloon is placed AWAY from the value so the
             measurement stays visible. The arrow then points
             back at the value.
          ===================================================== */

          const valueCenterX =
            item.x +
            (item.width || 0) / 2;

          /*
            PDF text y is the BASELINE (bottom of the text).
            OCR text y is the TOP of the word box.
          */

          const valueCenterY =
            item.source === 'ocr'
              ? item.y +
                (item.height || 0) /
                  2
              : item.y -
                (item.height || 0) /
                  2;

          /*
            Offset the balloon above the value,
            alternating left / right to spread
            neighbouring balloons apart.
          */

          const arrowDistance = 25;

          const horizontalSpread = 15;

          const balloonX =
            valueCenterX +
            (createdCount % 2 === 0
              ? horizontalSpread
              : -horizontalSpread);

          const balloonY =
            valueCenterY -
            arrowDistance;

          /*
            Detection status:
            - Selectable PDF text is read exactly => Verified
            - Low-confidence OCR still needs review
          */

          const detectionStatus =
            item.source === 'ocr' &&
            Number(item.confidence || 0) < 80
              ? 'Needs verification'
              : 'Verified';

          /* =====================================================
             CREATE BALLOON
          ===================================================== */

          const balloon =
            await api.post(
              `/projects/${id}/balloons`,
              {
                drawingId: selectedDrawingId,

                x:
                  balloonX,

                y:
                  balloonY,

                anchorX:
                  valueCenterX,

                anchorY:
                  valueCenterY,

                /* Page-relative position: stays locked to the
                   detected dimension at every zoom level. */
                xRel:
                  metrics
                    ? clamp01(balloonX / metrics.w)
                    : null,

                yRel:
                  metrics
                    ? clamp01(balloonY / metrics.h)
                    : null,

                anchorXRel:
                  metrics
                    ? clamp01(valueCenterX / metrics.w)
                    : null,

                anchorYRel:
                  metrics
                    ? clamp01(valueCenterY / metrics.h)
                    : null,

                /*
                  Store the ORIGINAL
                  dimension text.
  
                  Example:
  
                  16
  
                  or
  
                  25 ±0.05
                */

                text:
                  item.text,

                type:
                  item.type,

                number:
                  nextNumber,

                page:
                  pageNumber,

                status:
                  detectionStatus
              }
            );

          /* =====================================================
             CREATE CHARACTERISTIC
          ===================================================== */

          const characteristic =
            await api.post(
              `/projects/${id}/characteristics`,
              {
                drawingId: selectedDrawingId,

                balloonId:
                  balloon._id,

                number:
                  nextNumber,

                type:
                  item.type,

                /*
                  MAIN VALUE ONLY
  
                  Example:
                  16
                */

                value:
                  item.value,

                unit:
                  item.type === 'Angle' ? 'deg' : 'mm',

                /*
                  GROUPED TOLERANCES
  
                  Example:
                  +0.05
                  -0.03
                */

                plusTolerance:
                  item.plusTolerance,

                minusTolerance:
                  item.minusTolerance,

                upperLimit:
                  item.upperLimit ?? '0.00',

                lowerLimit:
                  item.lowerLimit ?? '0.00',

                /*
                  Combined engineering
                  specification.
  
                  Example:
  
                  16 +0.05/-0.03
  
                  OR
  
                  25 ±0.05
                */

                specification:
                  item.specification,

                inspectionMethod:
                  'Vernier Caliper',

                instrument:
                  '',

                actualValue:
                  '',

                result:
                  'NOT INSPECTED',

                remarks:
                  '',

                page:
                  pageNumber,

                x:
                  item.x,

                y:
                  item.y,

                xRel:
                  metrics
                    ? clamp01(item.x / metrics.w)
                    : null,

                yRel:
                  metrics
                    ? clamp01(item.y / metrics.h)
                    : null,

                status:
                  detectionStatus
              }
            );

          /* =====================================================
             UPDATE BALLOONS
          ===================================================== */

          setBalloons(
            (prev) => [
              ...prev,

              {
                ...balloon,

                number:
                  nextNumber,

                x:
                  balloonX,

                y:
                  balloonY,

                xRel:
                  metrics
                    ? clamp01(balloonX / metrics.w)
                    : null,

                yRel:
                  metrics
                    ? clamp01(balloonY / metrics.h)
                    : null,

                anchorXRel:
                  metrics
                    ? clamp01(valueCenterX / metrics.w)
                    : null,

                anchorYRel:
                  metrics
                    ? clamp01(valueCenterY / metrics.h)
                    : null,

                page:
                  pageNumber,

                /*
                  Keep detected value
                  available to UI.
                */

                text:
                  item.text,

                type:
                  item.type
              }
            ]
          );

          /* =====================================================
             UPDATE CHARACTERISTICS
          ===================================================== */

          setCharacteristics(
            (prev) => [
              ...prev,

              {
                ...characteristic,

                number:
                  nextNumber,

                value:
                  item.value,

                plusTolerance:
                  item.plusTolerance,

                minusTolerance:
                  item.minusTolerance,

                upperLimit:
                  item.upperLimit,

                lowerLimit:
                  item.lowerLimit,

                specification:
                  item.specification,

                x:
                  item.x,

                y:
                  item.y,

                xRel:
                  metrics
                    ? clamp01(item.x / metrics.w)
                    : null,

                yRel:
                  metrics
                    ? clamp01(item.y / metrics.h)
                    : null,

                page:
                  pageNumber
              }
            ]
          );

          createdCount++;

        } catch (error) {
          console.error(
            'Balloon creation failed:',
            error
          );
        }
      }

      /* =========================================================
         14. FINAL MESSAGE
      ========================================================= */

      if (
        createdCount === 0
      ) {
        setMessage(
          'No usable engineering characteristics were detected.'
        );
      } else {
        autoDetectDoneRef.current = true;
        setMessage(
          `${createdCount} engineering characteristic(s) detected successfully.`
        );
      }

    } catch (error) {
      console.error(
        'Automatic detection error:',
        error
      );

      setMessage(
        error.message ||
        'Automatic detection failed'
      );

    } finally {
      setAutoDetecting(false);
    }
  };
  /* =========================================================
   BALLOON DRAG EVENTS
========================================================= */

  useEffect(() => {
    window.addEventListener(
      'pointermove',
      handleBalloonPointerMove
    );

    window.addEventListener(
      'pointerup',
      handleBalloonPointerUp
    );

    return () => {
      window.removeEventListener(
        'pointermove',
        handleBalloonPointerMove
      );

      window.removeEventListener(
        'pointerup',
        handleBalloonPointerUp
      );
    };
  }, [
    balloons,
    characteristics
  ]);

  /* =========================================================
     KEYBOARD SHORTCUT
     "A" toggles the Add Dimension tool.
  ========================================================= */

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;

      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.key.toLowerCase() === 'a') {
        setMode((prev) =>
          prev === 'manual'
            ? 'none'
            : 'manual'
        );
      }
    };

    window.addEventListener(
      'keydown',
      onKeyDown
    );

    return () => {
      window.removeEventListener(
        'keydown',
        onKeyDown
      );
    };
  }, []);

  return (
    <div className="space-y-4">

      {/* =====================================================
          HEADER
      ===================================================== */}

      <div className="sticky top-0 z-40 bg-slate-100 pb-2">
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 shadow-sm flex flex-wrap items-center justify-between gap-2">

        <div className="leading-tight">
          <div className="text-xs text-slate-500">
            Project / Drawing Workspace
          </div>

          <div className="text-sm font-semibold text-slate-900">
            {project?.projectNumber ||
              'New Project'}
          </div>

          <div className="text-xs text-slate-600">
            {project?.customerName} •{' '}
            {project?.drawingNumber} Rev{' '}
            {project?.revision}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">

          {/* SELECT AREA */}
            <button
              className={`rounded border px-2 py-1 text-xs flex items-center gap-1 ${mode === 'select_area' ? 'bg-yellow-600 text-white' : ''}`}
              onClick={() => {
                if (mode === 'select_area') {
                  setMode('none');
                } else {
                  setMode('select_area');
                  setRoiRect(null); // Clear previous area when entering mode
                }
              }}
            >
              <Maximize size={15} />
              {mode === 'select_area' ? 'Draw Area...' : (roiRect ? 'Area Selected (Click to Reset)' : 'Select Area')}
            </button>
            
            {/* ADD DIMENSION (toggle, shortcut: A) */}

          <button
            className={`rounded border px-2 py-1 text-xs flex items-center gap-1 ${mode === 'manual'
              ? 'bg-slate-900 text-white'
              : ''
              }`}
            onClick={() =>
              setMode((prev) =>
                prev === 'manual'
                  ? 'none'
                  : 'manual'
              )
            }
          >
            <Plus size={15} />
            {mode === 'manual'
              ? 'Add Dimension: ON'
              : 'Add Dimension (A)'}
          </button>

          {/* ADD DIMENSION HINT */}

          {mode === 'manual' ? (
            <span className="text-xs text-amber-700">
              Click or drag over a dimension to read it
            </span>
          ) : null}

          {/* AUTO */}

          <button
            className={`rounded border px-2 py-1 text-xs flex items-center gap-1 ${mode === 'auto'
              ? 'bg-blue-600 text-white'
              : ''
              }`}
            onClick={autoDetect}
            disabled={
              autoDetecting ||
              !pdfPage
            }
          >
            <Wand2 size={15} />

            {autoDetecting
              ? 'Detecting...'
              : 'Auto Detect'}
          </button>

          {/* CLEAR ALL */}

          <button
            className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 flex items-center gap-1"
            onClick={
              clearAllBallooning
            }
            disabled={
              balloons.length === 0 &&
              characteristics.length === 0
            }
          >
            <Eraser size={15} />
            Clear All Ballooning
          </button>



          {/* DOWNLOAD PDF */}

          <button
            className="rounded border px-2 py-1 text-xs ml-2"
            onClick={downloadPdf}
            disabled={!selectedDrawing}
          >
            <Download size={15} className="inline mr-1" /> Download PDF
          </button>

          {/* ZOOM IN */}

          <button
            className="rounded border px-2 py-1 text-xs"
            onClick={() =>
              setZoom((z) =>
                Math.min(
                  MAX_ZOOM,
                  z + PHYSICAL_SCALE * 0.1
                )
              )
            }
          >
            <ZoomIn
              size={15}
              className="inline mr-1"
            />
            Zoom +
          </button>

          {/* ZOOM OUT */}

          <button
            className="rounded border px-2 py-1 text-xs"
            onClick={() =>
              setZoom((z) =>
                Math.max(
                  MIN_ZOOM,
                  z - PHYSICAL_SCALE * 0.1
                )
              )
            }
          >
            <ZoomOut
              size={15}
              className="inline mr-1"
            />
            Zoom -
          </button>

        </div>
      </div>
      </div>

      {/* =====================================================
          MESSAGE
      ===================================================== */}

      {message ? (
        <div className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
          {message}
        </div>
      ) : null}

      {/* =====================================================
          MAIN AREA
      ===================================================== */}

      <div className="grid gap-3 lg:grid-cols-[190px_minmax(0,1fr)_250px]">

        {/* ===================================================
            LEFT PANEL
        =================================================== */}

        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

          <div className="mb-3 font-semibold text-slate-900">
            Pages
          </div>

          <div className="flex items-center justify-between rounded border bg-slate-50 p-2 text-sm">

            <button
              onClick={
                previousPage
              }
              disabled={
                pageNumber <= 1
              }
              className="rounded p-1 hover:bg-white disabled:opacity-30"
            >
              <ChevronLeft
                size={18}
              />
            </button>

            <span>
              Page {pageNumber} /{' '}
              {pageCount}
            </span>

            <button
              onClick={nextPage}
              disabled={
                pageNumber >=
                pageCount
              }
              className="rounded p-1 hover:bg-white disabled:opacity-30"
            >
              <ChevronRight
                size={18}
              />
            </button>

          </div>

          {/* UPLOAD */}

          <div className="mt-4">

            <label className="block text-sm text-slate-600">
              Upload drawing
            </label>

            <input
              type="file"
              accept=".pdf,application/pdf"
              onChange={
                uploadDrawing
              }
              className="mt-2 block w-full text-sm"
            />

            {uploading ? (
              <div className="mt-2 text-sm text-slate-500">
                Uploading...
              </div>
            ) : null}

          </div>

          {/* DRAWINGS */}

          <div className="mt-4">

            <div className="mb-2 text-sm font-semibold text-slate-900">
              Drawings
            </div>

            <div className="space-y-2">

              {drawings.length ===
                0 ? (
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                  No drawings uploaded
                </div>
              ) : (
                drawings.map(
                  (item) => (

                    <div
                      key={
                        item._id
                      }
                      className={`relative group rounded border px-3 py-3 ${selectedDrawingId ===
                        item._id
                        ? 'border-slate-900 bg-slate-100'
                        : 'border-slate-200 bg-white'
                        }`}
                    >

                      <div className="flex items-center justify-between gap-3">

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDrawingId(
                              item._id
                            );

                            setActiveDrawingMenuId(
                              null
                            );
                          }}
                          className="flex min-w-0 items-center gap-2 text-left text-sm text-slate-800"
                        >
                          <span className="text-slate-500">
                            📄
                          </span>

                          <span className="truncate">
                            {
                              item.fileName
                            }
                          </span>

                        </button>

                        <button
                          type="button"
                          onClick={(
                            event
                          ) => {
                            event.stopPropagation();

                            setActiveDrawingMenuId(
                              (
                                current
                              ) =>
                                current ===
                                  item._id
                                  ? null
                                  : item._id
                            );
                          }}
                          className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100"
                        >
                          ⋮
                        </button>

                      </div>

                      {activeDrawingMenuId ===
                        item._id ? (
                        <div className="absolute right-3 top-full z-20 mt-2 w-40 overflow-hidden rounded border bg-white shadow-lg">

                          <button
                            type="button"
                            onClick={() => {
                              window.open(
                                drawingUrlFor(
                                  item
                                ),
                                '_blank',
                                'noopener'
                              );

                              setActiveDrawingMenuId(
                                null
                              );
                            }}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                          >
                            Open PDF
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              const newName =
                                window.prompt(
                                  'Rename drawing',
                                  item.fileName
                                );

                              if (
                                newName &&
                                newName.trim() &&
                                newName.trim() !==
                                item.fileName
                              ) {
                                renameDrawing(
                                  item._id,
                                  newName.trim()
                                );
                              }
                            }}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                          >
                            Rename
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteDrawingId(
                                item._id
                              );

                              setActiveDrawingMenuId(
                                null
                              );
                            }}
                            className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-slate-50"
                          >
                            Delete
                          </button>

                        </div>
                      ) : null}

                    </div>

                  )
                )
              )}

            </div>

          </div>

        </div>

        {/* ===================================================
            PDF VIEWER
        =================================================== */}

        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-10 bg-white py-1">

            <div className="font-semibold text-slate-900">
              Engineering Drawing Viewer
            </div>

            <div className="flex items-center gap-2">

              <span className="rounded bg-slate-100 px-3 py-1 text-xs text-slate-600">
                {mode ===
                  'manual'
                  ? 'Manual Ballooning'
                  : 'Automatic Ballooning'}
              </span>

              <span className="text-xs text-slate-500">
                Zoom{' '}
                {Math.round(
                  (zoom / PHYSICAL_SCALE) * 100
                )}
                %
              </span>

            </div>

          </div>

          <div
            ref={
              pdfContainerRef
            }
            className="relative h-[70vh] overflow-auto rounded-lg border border-slate-300 bg-slate-200"
          >

            {!selectedDrawing ? (

              <div className="absolute inset-0 flex items-center justify-center text-slate-400">
                Upload a drawing to begin ballooning
              </div>

            ) : loadingPdf ? (

              <div className="absolute inset-0 flex items-center justify-center">
                <div className="rounded-lg bg-white px-5 py-4 shadow">
                  Loading engineering drawing...
                </div>
              </div>

            ) : drawingError ? (

              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-4 text-center">

                <div className="text-lg font-semibold">
                  Unable to load drawing
                </div>

                <div className="max-w-xl break-all text-sm text-slate-500">
                  {drawingUrl}
                </div>

                <button
                  type="button"
                  onClick={() =>
                    window.open(
                      drawingUrl,
                      '_blank',
                      'noopener'
                    )
                  }
                  className="rounded bg-slate-900 px-4 py-2 text-sm text-white"
                >
                  Open PDF
                </button>

              </div>

            ) : isPdf ? (

              <div className="w-max min-w-full p-5 mx-auto">

                <div
                  className="relative bg-white shadow-xl"
                  style={
                    mode === 'manual'
                      ? { touchAction: 'none' }
                      : undefined
                  }
                  onPointerDown={
                    handleAddPointerDown
                  }
                  onPointerMove={
                    handleAddPointerMove
                  }
                  onPointerUp={
                    handleAddPointerUp
                  }
                >

                  <canvas
                    ref={
                      canvasRef
                    }
                    className="block"
                  />

                  {/* BALLOON OVERLAY */}

                  <div className="pointer-events-none absolute inset-0">

                    {/* LEADER ARROWS: each balloon points an
                        arrow at its measurement / value */}

                    <svg
                      className="absolute inset-0 h-full w-full"
                      style={{ overflow: 'visible' }}
                    >
                      {displayedBalloons
                        .filter(
                          (
                            balloon
                          ) =>
                            !balloon.page ||
                            balloon.page ===
                            pageNumber
                        )
                        .map(
                          (
                            balloon
                          ) => {
                            if (
                              !viewSize.w ||
                              !viewSize.h
                            ) {
                              return null;
                            }

                            /*
                              Positions are page-relative, so
                              they are resolved against the
                              current size of the drawing and
                              therefore follow every zoom.
                            */

                            const x =
                              balloon.xRel != null
                                ? balloon.xRel * viewSize.w
                                : (balloon.x ?? 0) / legacyDRatio;
                            const y =
                              balloon.yRel != null
                                ? balloon.yRel * viewSize.h
                                : (balloon.y ?? 0) / legacyDRatio;

                            const hasPixelAnchor =
                              (balloon.anchorX ?? 0) !== 0 ||
                              (balloon.anchorY ?? 0) !== 0;

                            const ax =
                              balloon.anchorXRel != null
                                ? balloon.anchorXRel * viewSize.w
                                : hasPixelAnchor
                                  ? (balloon.anchorX ?? 0) / legacyDRatio
                                  : x + 25;
                            const ay =
                              balloon.anchorYRel != null
                                ? balloon.anchorYRel * viewSize.h
                                : hasPixelAnchor
                                  ? (balloon.anchorY ?? 0) / legacyDRatio
                                  : y + 25;

                            /*
                              Direction from the balloon
                              TOWARDS the value.
                            */

                            const dx =
                              ax - x;

                            const dy =
                              ay - y;

                            const dist =
                              Math.hypot(
                                dx,
                                dy
                              ) || 1;

                            const ux =
                              dx / dist;

                            const uy =
                              dy / dist;

                            /*
                              Balloon marker radius
                              (h-6 circle => 12px).
                            */

                            const R = 10;
                            const head = 7;

                            /*
                              Line starts at the balloon
                              edge and ends at the value.
                            */

                            const startX =
                              x + ux * R;

                            const startY =
                              y + uy * R;

                            const angle =
                              Math.atan2(
                                uy,
                                ux
                              );

                            return (
                              <g
                                key={`arrow-${balloon._id}`}
                              >
                                {/* leader line */}
                                <line
                                  x1={startX}
                                  y1={startY}
                                  x2={ax}
                                  y2={ay}
                                  stroke="rgba(220, 38, 38, 0.4)"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                />

                                {/* arrowhead pointing AT
                                    the measurement */}
                                <polygon
                                  points={`${ax},${ay} ${ax - head * Math.cos(angle - 0.35)},${ay - head * Math.sin(angle - 0.35)} ${ax - head * Math.cos(angle + 0.35)},${ay - head * Math.sin(angle + 0.35)}`}
                                  fill="rgba(220, 38, 38, 0.7)"
                                />

                                {/* draggable anchor tip */}
                                <circle
                                  cx={ax}
                                  cy={ay}
                                  r={8}
                                  fill="#3b82f6"
                                  opacity="0.8"
                                  className="cursor-move pointer-events-auto"
                                  onPointerDown={(e) => handleAnchorPointerDown(e, balloon)}
                                />
                              </g>
                            );
                          }
                        )}
                    </svg>

                    {displayedBalloons
                      .filter(
                        (
                          balloon
                        ) =>
                          !balloon.page ||
                          balloon.page ===
                          pageNumber
                      )
                      .map(
                        (
                          balloon
                        ) => (

                          <div
                            key={balloon._id}
                            className="absolute pointer-events-auto balloon-marker cursor-move select-none"
                            style={{
                              left:
                                balloon.xRel != null && viewSize.w
                                  ? balloon.xRel * viewSize.w
                                  : (balloon.x ?? 0) / legacyDRatio,
                              top:
                                balloon.yRel != null && viewSize.h
                                  ? balloon.yRel * viewSize.h
                                  : (balloon.y ?? 0) / legacyDRatio,
                              transform:
                                'translate(-50%, -50%)',
                              touchAction: 'none'
                            }}
                            onPointerDown={(event) =>
                              handleBalloonPointerDown(
                                event,
                                balloon
                              )
                            }
                          >

                            <button
                              type="button"
                              className={`flex h-6 min-w-6 items-center justify-center rounded-full border-[1.5px] px-1.5 text-[10px] font-bold shadow-sm ${selectedBalloonId ===
                                balloon._id
                                ? 'border-yellow-500 bg-yellow-400/50 text-yellow-900 backdrop-blur-[1px]'
                                : 'border-red-500 border-[1.5px] bg-red-900/60 text-white backdrop-blur-[1px]'
                                }`}
                              onPointerDown={(event) => {
                                event.stopPropagation();

                                handleBalloonPointerDown(
                                  event,
                                  balloon
                                );
                              }}
                            >
                              {balloon.number}
                            </button>

                          </div>

                        )
                      )}

                    {/* ROI RECTANGLE */}
                    {roiRect ? (
                      (() => {
                        const roi = roiRectToCanvas(roiRect);

                        return (
                          <div
                            className="absolute border-2 border-yellow-500 bg-yellow-400/20"
                            style={{
                              left: Math.min(roi.x1, roi.x2) / dRatio,
                              top: Math.min(roi.y1, roi.y2) / dRatio,
                              width: Math.abs(roi.x2 - roi.x1) / dRatio,
                              height: Math.abs(roi.y2 - roi.y1) / dRatio,
                              pointerEvents: 'none'
                            }}
                          />
                        );
                      })()
                    ) : null}

                    {/* ADD DIMENSION SELECTION RECTANGLE */}

                    {mode === 'manual' &&
                    selectRect ? (
                      <div
                        className="absolute border-2 border-blue-500 bg-blue-400/20"
                        style={{
                          left: selectRect.x1 / dRatio,
                            top: selectRect.y1 / dRatio,
                            width: (selectRect.x2 - selectRect.x1) / dRatio,
                            height: (selectRect.y2 - selectRect.y1) / dRatio
                        }}
                      />
                    ) : null}

                    {mode === 'manual' &&
                    addScanning ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="rounded-lg bg-slate-900/80 px-5 py-4 text-sm text-white shadow">
                          Reading dimension from drawing...
                        </div>
                      </div>
                    ) : null}

                  </div>

                </div>

              </div>

            ) : (

              <div className="flex h-full min-h-[650px] items-center justify-center p-5">

                <img
                  src={
                    drawingUrl
                  }
                  alt={
                    selectedDrawing.fileName
                  }
                  /*
                    No size cap: scaling a raster drawing down to
                    fit the panel destroys exactly the detail the
                    dimension text lives in.  The container scrolls.
                  */
                  className="block max-w-none"
                />

              </div>

            )}

          </div>

          {/* VIEWER CONTROLS */}

          {isPdf &&
            pdfPage ? (

            <div className="mt-3 flex items-center justify-center gap-2">

              <button
                onClick={() =>
                  setZoom(fitZoom())
                }
                className="rounded border bg-white px-3 py-2 text-sm"
              >
                <Maximize
                  size={14}
                  className="inline mr-1"
                />
                Fit
              </button>

              <button
                onClick={() =>
                  setZoom(PHYSICAL_SCALE)
                }
                className={`rounded border px-3 py-2 text-sm ${
                  Math.abs(zoom - PHYSICAL_SCALE) < 0.001
                    ? 'bg-slate-900 text-white'
                    : 'bg-white'
                }`}
                title="Show the drawing at its real printed size"
              >
                100%
              </button>

              <button
                onClick={
                  previousPage
                }
                disabled={
                  pageNumber <=
                  1
                }
                className="rounded border px-2 py-1 text-xs disabled:opacity-40"
              >
                Previous
              </button>

              <span className="px-3 text-sm text-slate-600">
                {pageNumber} /{' '}
                {pageCount}
              </span>

              <button
                onClick={
                  nextPage
                }
                disabled={
                  pageNumber >=
                  pageCount
                }
                className="rounded border px-2 py-1 text-xs disabled:opacity-40"
              >
                Next
              </button>

            </div>

          ) : null}

        </div>

        {/* ===================================================
            SELECTED BALLOON
        =================================================== */}

        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

          <div className="mb-3 font-semibold text-slate-900">
            Edit Balloon / Characteristic
          </div>

          <div className="space-y-4">

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Balloon No
              </label>

              <input
                type="text"
                value={currentBalloonNo}
                onFocus={() => setFocusedField('currentBalloonNo')}
                onChange={(e) =>
                  handleBalloonNumberChange(e.target.value)
                }
                onKeyDown={handleBalloonNumberKeyDown}
                onBlur={saveEdit}
                placeholder="Enter balloon number"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <div className="mb-2 flex flex-wrap gap-1">
                {['Ø', 'R', '↧', '⌴', '⌵', '°', '±', '×', 'Ⓜ', 'Ⓛ', '⟂', '∥', '∠', '⌖', '◯', '▱'].map(sym => (
                  <button
                    key={sym}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertSymbol(sym)}
                    className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200"
                  >
                    {sym}
                  </button>
                ))}
              </div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Description
              </label>

              <input
                type="text"
                value={editData?.specification ?? ''}
                onFocus={() => setFocusedField('specification')}
                onChange={(e) => {
                  const typed = e.target.value;
                  setEditData((prev) => {
                    if (!prev) return prev;
                    /* Keep Dimensions No / tolerances in step with
                       the description as it is typed. */
                    const synced = normalizeCallout(
                      {
                        specification: typed,
                        value: typed,
                        plusTolerance: prev.plusTolerance,
                        minusTolerance: prev.minusTolerance
                      },
                      { prefer: 'spec' }
                    );
                    if (!synced) {
                      /* "±0.05" alone parses as no callout - treat it
                         as a symmetric tolerance for both boxes. */
                      const symTol = extractSymmetricTol(typed);
                      if (symTol) {
                        return {
                          ...prev,
                          specification: typed,
                          plusTolerance: symTol,
                          minusTolerance: symTol
                        };
                      }
                      return { ...prev, specification: typed };
                    }
                    return {
                      ...prev,
                      specification: typed,
                      value: synced.value,
                      plusTolerance: synced.plusTolerance,
                      minusTolerance: synced.minusTolerance
                    };
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setTimeout(() => saveEdit(), 50);
                  }
                }}
                onBlur={saveEdit}
                placeholder="—"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Dimensions No</label>

              <input
                type="text"
                value={editData?.value ?? ''}
                onFocus={() => {
                  valueNominalStashRef.current = editData?.value ?? '';
                  setFocusedField('value');
                }}
                onChange={(e) => {
                  const typed = e.target.value;
                  setEditData((prev) =>
                    prev
                      ? {
                          ...prev,
                          value: typed,
                          specification: composeSpecification(
                            typed,
                            prev.plusTolerance,
                            prev.minusTolerance,
                            prev.specification
                          )
                        }
                      : prev
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  /*
                    "±0.05" typed as the dimension is really a
                    tolerance: put it into both tolerance boxes and
                    give the field back its nominal number.
                  */
                  commitValueField();
                }}
                onBlur={commitValueField}
                placeholder="—"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Upper Tolerance</label>

              <input
                type="text"
                value={editData?.plusTolerance ?? ''}
                onFocus={() => setFocusedField('plusTolerance')}
                onChange={(e) => {
                  const typed = e.target.value;
                  setEditData((prev) =>
                    prev
                      ? {
                          ...prev,
                          plusTolerance: typed,
                          specification: composeSpecification(
                            prev.value,
                            typed,
                            prev.minusTolerance,
                            prev.specification
                          )
                        }
                      : prev
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTolField('plusTolerance');
                  }
                }}
                onBlur={() => commitTolField('plusTolerance')}
                placeholder="—"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Lower Tolerance</label>

              <input
                type="text"
                value={editData?.minusTolerance ?? ''}
                onFocus={() => setFocusedField('minusTolerance')}
                onChange={(e) => {
                  const typed = e.target.value;
                  setEditData((prev) =>
                    prev
                      ? {
                          ...prev,
                          minusTolerance: typed,
                          specification: composeSpecification(
                            prev.value,
                            prev.plusTolerance,
                            typed,
                            prev.specification
                          )
                        }
                      : prev
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTolField('minusTolerance');
                  }
                }}
                onBlur={() => commitTolField('minusTolerance')}
                placeholder="—"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <button
              type="button"
              onClick={saveEdit}
              disabled={!editData || !!savingCharacteristicId}
              className="flex w-full items-center justify-center gap-2 rounded border border-slate-900 bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingCharacteristicId ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              {savingCharacteristicId ? 'Saving...' : 'Save'}
            </button>

            <button
              onClick={() => deleteBalloon(selectedBalloonId)}
              disabled={!editData}
              className="flex w-full items-center justify-center gap-2 rounded border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 size={14} />
              Delete Balloon
            </button>

            <button
              type="button"
              onClick={() => setShowCharacteristicsTable(true)}
              className="flex w-full items-center justify-center gap-2 rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              <Table2 size={14} />
              Table
            </button>

          </div>

        </div>

        {/* =====================================================
          DELETE DRAWING CONFIRMATION
      ===================================================== */}

        {confirmDeleteDrawingId ? (

          <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4">

            <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">

              <div className="mb-4 text-lg font-semibold">
                Confirm drawing delete
              </div>

              <div className="mb-6 text-sm text-slate-600">
                This will remove the drawing file and its viewer entry. Are you sure?
              </div>

              <div className="flex justify-end gap-3">

                <button
                  onClick={() =>
                    setConfirmDeleteDrawingId(
                      null
                    )
                  }
                  className="rounded border px-4 py-2 text-sm"
                >
                  Cancel
                </button>

                <button
                  onClick={() =>
                    deleteDrawing(
                      confirmDeleteDrawingId
                    )
                  }
                  className="rounded bg-red-600 px-4 py-2 text-sm text-white"
                >
                  Delete
                </button>

              </div>

            </div>

          </div>

        ) : null}

        {/* =====================================================
          CHARACTERISTICS TABLE MODAL
      ===================================================== */}

        {showCharacteristicsTable ? (

          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">

            <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl bg-white p-6 shadow-xl">

              <div className="mb-4 flex items-center justify-between">

                <div className="text-lg font-semibold">
                  Ballooning Table
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={exportToExcel}
                    className="flex items-center gap-2 rounded bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700"
                  >
                    <Download size={14} />
                    Download Excel
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setShowCharacteristicsTable(false)
                    }
                    className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Close
                  </button>
                </div>

              </div>

              {characteristics.length === 0 ? (

                <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
                  No ballooning yet for this project.
                </div>

              ) : (

                <div className="overflow-auto rounded-lg border border-slate-200">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                      <tr>
                        <th className="px-4 py-3">Balloon No</th>
                        <th className="px-4 py-3">Description</th>
                        <th className="px-4 py-3">Dimensions No</th>
                        <th className="px-4 py-3">Upper Tolerance</th>
                        <th className="px-4 py-3">Lower Tolerance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {characteristics
                        .slice()
                        .sort((a, b) =>
                          Number(a.number || 0) - Number(b.number || 0)
                        )
                                                .map((characteristic) => {
                          const d = getDisplayValues(characteristic);
                          return (
                          <tr
                            key={characteristic._id}
                            className="border-t border-slate-100 hover:bg-slate-50"
                          >
                            <td className="px-4 py-3 font-semibold text-slate-800">
                              {characteristic.number || '-'}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {d.specification || '-'}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {d.mainVal || '-'}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {d.plusTol || '-'}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {d.minusTol || '-'}
                            </td>
                          </tr>
                        )})}
                    </tbody>
                  </table>
                </div>

              )}

            </div>

          </div>

        ) : null}

    </div>
  </div>
  );
}
