import { normalizeCallout, splitCalloutText } from './calloutFormat.js';

export const enhanceDetections = (items, pageWidth = 0, pageHeight = 0, unitScale = 1) => {
  if (!items || items.length === 0) return [];

  /*
    The pixel windows below were tuned against canvas pixels at one
    device pixel per CSS pixel. The main canvas renders at exactly
    devicePixelRatio, so unitScale (render pixels per CSS pixel)
    scales every absolute window to keep the behaviour identical on
    every display.
  */
  const u = unitScale > 0 ? unitScale : 1;
  const CLUSTER_DX = 50 * u;
  const CLUSTER_DY = 40 * u;
  const DENSITY_TOL = 15 * u;
  const KEYWORD_NEAR = 150 * u;
  const DEDUPE_NEAR = 20 * u;

  const processedItems = items.map(item => ({
    ...item,
    normText: item.text.trim().toUpperCase()
  }));

  const grouped = [];
  const used = new Set();

  for (let i = 0; i < processedItems.length; i++) {
    if (used.has(i)) continue;
    const base = processedItems[i];
    let clusterText = base.text;
    let minX = base.x;
    let minY = base.y;
    let maxX = base.x + (base.width || 0);
    let maxY = base.y + (base.height || 0);
    let confidence = base.confidence;
    const frags = [
      {
        text: base.text,
        x: base.x,
        y: base.y,
        width: base.width || 0,
        height: base.height || 0
      }
    ];

    for (let j = i + 1; j < processedItems.length; j++) {
      if (used.has(j)) continue;
      const other = processedItems[j];
      
      const dx = Math.abs(base.x - other.x);
      const dy = Math.abs(base.y - other.y);

      /*
        PDF text spans are fragmented (a value can arrive as several
        little pieces), so they keep the generous legacy windows.
        OCR words are already whole words - on drawings without a
        text layer they must stay on their own line, otherwise
        neighbouring dimension chains ("79 40 39") merge into one
        useless callout.
      */
      const ocrPair = base.source === 'ocr' || other.source === 'ocr';
      const hMax = Math.max(base.height || 0, other.height || 0);
      const cdx = ocrPair ? Math.max(12 * u, 2.5 * hMax) : CLUSTER_DX;
      const cdy = ocrPair ? Math.max(6 * u, 1.8 * hMax) : CLUSTER_DY;

      if (dx < cdx && dy < cdy) {
        clusterText += ' ' + other.text;
        used.add(j);
        minX = Math.min(minX, other.x);
        minY = Math.min(minY, other.y);
        maxX = Math.max(maxX, other.x + (other.width || 0));
        maxY = Math.max(maxY, other.y + (other.height || 0));
        frags.push({
          text: other.text,
          x: other.x,
          y: other.y,
          width: other.width || 0,
          height: other.height || 0
        });
      }
    }
    
    grouped.push({
      text: clusterText,
      normText: clusterText.toUpperCase(),
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      confidence,
      frags
    });
  }

  const xTols = DENSITY_TOL;
  const yTols = DENSITY_TOL;
  
  grouped.forEach(item => {
    item.colDensity = grouped.filter(o => Math.abs(o.centerX - item.centerX) < xTols).length;
    item.rowDensity = grouped.filter(o => Math.abs(o.centerY - item.centerY) < yTols).length;
  });

  const keywords = grouped.filter(i => /^(REV|DATE|SCALE|WEIGHT|SHEET|MATERIAL|DRAWN|CHECKED)/.test(i.normText));
  const finalCandidates = [];

  grouped.forEach(item => {
    const parts = rebindLeadingQty(splitCalloutText(item.text), item.frags, u);
    const boxes = assignPartBoxes(parts, item);

    parts.forEach((part, partIndex) => {
      let score = 0;
      const parsed = parseCallout(part);
      if (!parsed) return;

      score += parsed.score;

      /*
        The column/row density penalty targets structured PDF text
        grids (title blocks, BOM tables). On OCR drawings the words
        are scattered all over the sheet, so a view dimension can
        accidentally line up with a table column - never penalise
        OCR-sourced items for that.
      */
      const densityHits = item.colDensity > 3 && item.rowDensity > 3
        ? true
        : item.colDensity > 4;
      if (densityHits && base.source !== 'ocr') {
        score -= 50;
      }

      const nearKeyword = keywords.some(k => Math.hypot(k.centerX - item.centerX, k.centerY - item.centerY) < KEYWORD_NEAR);
      if (nearKeyword) {
        score -= 40;
      }

      if (/^(COMMON FOR|NOTES|ALL UNSPECIFIED|UNLESS OTHERWISE)/.test(part.toUpperCase())) {
        score -= 35;
      }

      const box = boxes[partIndex] || {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height
      };

      if (score > 0) {
        finalCandidates.push({
          ...item,
          text: part,
          normText: part.toUpperCase(),
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          centerX: box.x + box.width / 2,
          centerY: box.y + box.height / 2,
          splitPart: parts.length > 1,
          ...parsed,
          confidence: score
        });
      }
    });
  });

  const unique = [];
  finalCandidates.sort((a, b) => b.confidence - a.confidence).forEach(c => {
    /*
      Two stacked callouts ("3 × 4.2 12" / "M5x0.8 10") can land
      in the same region - keep sibling parts of one note, but
      keep dropping every other same-spot duplicate (title-block
      cells etc.) exactly as before.
    */
    const drop = unique.some((u) => {
      const near =
        Math.hypot(u.centerX - c.centerX, u.centerY - c.centerY) < DEDUPE_NEAR;
      if (!near) return false;
      if (u.value === c.value) return true;
      return !(u.splitPart && c.splitPart);
    });
    if (!drop) {
      unique.push(c);
    }
  });

  return unique;
};

/*
 * The PDF content-stream order of a stacked note can interleave
 * the lines ("4.2 12 3 x M5x0.8 10"), so the splitter binds the
 * quantity to the thread part. Move a leading quantity back to
 * the earlier part when its text fragment sits on the SAME line
 * as that part's fragments (row distance is tiny).
 */
const rebindLeadingQty = (parts, frags, u = 1) => {
  if (parts.length < 2 || !frags || frags.length === 0) return parts;

  const out = parts.slice();
  for (let i = 1; i < out.length; i++) {
    const m = out[i].match(/^\s*([1-9]\d*\s*[x\u00d7]\s+)/i);
    if (!m) continue;
    const rest = out[i].slice(m[0].length);
    if (!rest || !/[M\d]/.test(rest)) continue;

    const qtyToken = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    const qf = frags.find(
      (f) =>
        String(f.text || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ') === qtyToken
    );
    if (!qf) continue;
    const qh = qf.height || 0;
    const qcy = qf.y + qh / 2;
    const rowTol = Math.max(3 * u, qh * 0.6);

    let bestK = -1;
    let bestD = Infinity;
    for (let k = 0; k < i; k++) {
      const up = out[k].toUpperCase();
      let d = Infinity;
      frags.forEach((f) => {
        const ft = String(f.text || '')
          .trim()
          .toUpperCase();
        if (!ft || !up.includes(ft)) return;
        const dist = Math.abs(f.y + (f.height || 0) / 2 - qcy);
        if (dist < d) d = dist;
      });
      if (d < bestD) {
        bestD = d;
        bestK = k;
      }
    }

    if (bestK >= 0 && bestD <= rowTol) {
      out[bestK] = `${m[1].trim()} ${out[bestK].trim()}`;
      out[i] = rest;
    }
  }
  return out;
};

/*
 * Give each split part of a stacked note the box of the original
 * text fragments that belong to it, so the two balloons do not
 * land on top of each other. Fragments are matched to parts in
 * reading order.
 */
const assignPartBoxes = (parts, item) => {
  if (parts.length <= 1) {
    return [{
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    }];
  }

  const frags = item.frags || [];
  const partUp = parts.map(p => String(p).toUpperCase());
  const boxes = parts.map(() => null);
  let cursor = 0;

  frags.forEach(frag => {
    const ft = String(frag.text || '').toUpperCase().trim();
    const fx = frag.x;
    const fy = frag.y;
    const fw = frag.width || 0;
    const fh = frag.height || 0;

    if (ft) {
      /*
        A single OCR/merged fragment may contain several split
        parts ("3 × 4.2 12 M5x0.8 10") - slice its box by the
        character range of each part so the balloons separate.
      */
      const starts = parts.map((_p, k) => ft.indexOf(partUp[k]));
      const hits = [];
      starts.forEach((s, k) => { if (s >= 0) hits.push({ s, e: s + partUp[k].length, k }); });
      if (hits.length >= 2 && ft.length > 0) {
        hits.forEach(({ s, e, k }) => {
          const slice = {
            x: fx + (fw * s) / ft.length,
            y: fy,
            width: Math.max(1, (fw * (e - s)) / ft.length),
            height: fh
          };
          boxes[k] = growBox(boxes[k], slice);
        });
        return;
      }
    }

    let partIndex = -1;

    if (ft) {
      for (let k = cursor; k < parts.length; k++) {
        if (partUp[k].includes(ft)) { partIndex = k; break; }
      }
      if (partIndex === -1) {
        for (let k = 0; k < parts.length; k++) {
          if (partUp[k].includes(ft)) { partIndex = k; break; }
        }
      }
    }
    if (partIndex === -1) partIndex = Math.min(cursor, parts.length - 1);
    cursor = partIndex;

    boxes[partIndex] = growBox(boxes[partIndex], { x: fx, y: fy, width: fw, height: fh });
  });

  return boxes.map((b, k) => b || {
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height
  });
};

const growBox = (box, add) => {
  if (!box) return add;
  const x1 = Math.min(box.x, add.x);
  const y1 = Math.min(box.y, add.y);
  const x2 = Math.max(box.x + box.width, add.x + add.width);
  const y2 = Math.max(box.y + box.height, add.y + add.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};


/*
 * Read one detected text region into a canonical callout. The shared
 * parser first (it reorders stacked tolerances like "+0.05 7.2 +0.03"
 * into "Ø 7.2 +0.05 +0.03"); if it refuses the text the legacy
 * parser keeps the old, more permissive behaviour so no detection
 * that used to survive is lost.
 */
const parseCallout = (text) => {
  const normalized = normalizeCallout({ specification: text });

  if (normalized) {
    const hasPlus = normalized.plusTolerance !== '0.00';
    const hasMinus = normalized.minusTolerance !== '0.00';

    let score = 10;
    if (normalized.type === 'Diameter' || normalized.type === 'Radius') score += 5;
    if (normalized.type === 'Thread') score += 10;
    if (normalized.type === 'Fit' || normalized.type === 'Angle') score += 15;
    if (hasPlus || hasMinus) score += 15;
    if (hasPlus && hasMinus && normalized.plusTolerance !== normalized.minusTolerance) score += 5;

    return {
      type: normalized.type,
      value: normalized.value,
      specification: normalized.specification,
      plusTolerance: normalized.plusTolerance,
      minusTolerance: normalized.minusTolerance,
      upperLimit: normalized.upperLimit,
      lowerLimit: normalized.lowerLimit,
      score
    };
  }

  return legacyParseCallout(text);
};


const legacyParseCallout = (text) => {
  const norm = text.toUpperCase().replace(/\s+/g, ' ');
  let result = { type: 'Dimension', value: norm, specification: text, plusTolerance: '0.00', minusTolerance: '0.00', score: 0 };

  // Plus/Minus matching (± or +/- or +- or + -)
  const plusMinusRe = /^\s*(?:[1-9]\d*X\s*)?(?:\u00d8|\u2205|R|M|S\u00d8|SR)?\s*(\d+(?:\.\d+)?)(?:\s*[A-Z0-9]+)*\s*(?:\u00b1|\+\s*\/\s*-|\+\s*-)\s*(\d+(?:\.\d+)?)/i;
  const pmMatch = norm.match(plusMinusRe);
  if (pmMatch) {
    result.type = norm.includes('Ø') || norm.includes('A~') ? 'Diameter' : norm.includes('R') ? 'Radius' : norm.includes('M') ? 'Thread' : 'Dimension';
    result.score += 25;
    
    // Extract proper values
    let prefix = '';
    const prefixMatch = text.match(/^\s*([1-9]\d*X\s*)?(Ø|A~|R|M|SØ|SR)/i);
    if (prefixMatch) {
      prefix = prefixMatch[0].trim() + (prefixMatch[0].endsWith('X') ? ' ' : '');
    }
    result.value = prefix + pmMatch[1];
    result.plusTolerance = '+' + pmMatch[2];
    result.minusTolerance = '-' + pmMatch[2];
    return result;
  }

  // Bilateral matching (+X/-Y)
  const bilateralRe = /^\s*(?:[1-9]\d*X\s*)?(?:\u00d8|\u2205|R|M|S\u00d8|SR)?\s*(\d+(?:\.\d+)?)(?:\s*[A-Z0-9]+)*\s*\+\s*(\d+(?:\.\d+)?)\s*\/\s*-\s*(\d+(?:\.\d+)?)/i;
  const blMatch = norm.match(bilateralRe);
  if (blMatch) {
    result.type = norm.includes('Ø') || norm.includes('A~') ? 'Diameter' : norm.includes('R') ? 'Radius' : norm.includes('M') ? 'Thread' : 'Dimension';
    result.score += 30;
    
    let prefix = '';
    const prefixMatch = text.match(/^\s*([1-9]\d*X\s*)?(Ø|A~|R|M|SØ|SR)/i);
    if (prefixMatch) {
      prefix = prefixMatch[0].trim() + (prefixMatch[0].endsWith('X') ? ' ' : '');
    }
    result.value = prefix + blMatch[1];
    result.plusTolerance = '+' + blMatch[2];
    result.minusTolerance = '-' + blMatch[3];
    return result;
  }

  if (/M\d+(?:\.\d+)?(?:\s*[XA-]\s*\d+(?:\.\d+)?)?(?:\s*THRU)?/i.test(norm)) {
    result.type = 'Thread';
    result.score += 25;
    result.value = norm.match(/M\d+(?:\.\d+)?(?:\s*[XA-]\s*\d+(?:\.\d+)?)?/i)[0];
    return result;
  }

  /*
    Lost-Ø recovery. Non-letter leads (±, digits, symbols) keep the
    historic "^." behaviour - a tolerance-first cluster ("±0.1 90
    ±0.05 ...") must still produce a candidate so the vector-ring
    enrichment can turn it into "Ø 90". Letters are excluded so
    chamfer/grade labels ("C1", "A3") are not faked into diameters;
    O and Q remain as Ø look-alikes.
  */
  if (/(?:Ø|A~|^[OQ]|^[^\p{L}])\s*(\d+(?:\.\d+)?)/iu.test(norm)) {
    result.type = 'Diameter';
    result.score += 15;
    const match = norm.match(/(?:Ø|A~|^[OQ]|^[^\p{L}])\s*(\d+(?:\.\d+)?)/iu);
    result.value = 'Ø' + match[1];
    return result;
  }

  if (/R\s*(\d+(?:\.\d+)?)/i.test(norm)) {
    result.type = 'Radius';
    result.score += 15;
    const match = norm.match(/R\s*(\d+(?:\.\d+)?)/i);
    result.value = match[1];
    return result;
  }

  /*
    Stacked/quantity note such as "3 × 4.2 12" where the Ø is drawn
    as vector art. The quantity and value belong together - the old
    numeric branch returned only the quantity ("3").
  */
  const qtyMatch = norm.match(/^\s*([1-9]\d*)\s*[X\u00d7]\s*(\d+(?:\.\d+)?)/);
  if (qtyMatch) {
    result.type = 'Dimension';
    result.score += 15;
    result.value = qtyMatch[1] + ' X ' + qtyMatch[2];
    return result;
  }

  if (/(\d+(?:\.\d+)?)\s*([A-Z]{1,2}\d{1,2})/.test(norm)) {
    result.type = 'Fit';
    result.score += 25;
    const match = norm.match(/(\d+(?:\.\d+)?)\s*([A-Z]{1,2}\d{1,2})/);
    result.value = match[1] + ' ' + match[2];
    return result;
  }

  if (/(?:[1-9]\d*X\s*)?\d+(?:\.\d+)?/.test(norm) && text.length < 15 && !/[A-Z]{3,}/.test(norm)) {
    result.type = 'Dimension';
    result.score += 10;
    const match = norm.match(/(?:[1-9]\d*X\s*)?(\d+(?:\.\d+)?)/);
    result.value = match[0];
    return result;
  }

  return null;
};
