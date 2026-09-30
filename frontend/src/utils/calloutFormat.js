/*
 * Canonical callout parsing / formatting for the drawing workspace.
 *
 * normalizeCallout() turns the raw characteristic fields
 * (specification / value / tolerances / type) into the canonical
 * right-column format:
 *
 *   specification : "Ø 7.2 +0.05 +0.03"
 *   value         : "Ø 7.2"
 *   plusTolerance : "0.05"      (unsigned magnitude)
 *   minusTolerance: "0.03"      (unsigned magnitude)
 *
 * Tolerances are recognised no matter where they sit in the raw text
 * (drawings stack them above/below the value, PDF text layers often
 * emit the tolerance first), so "+0.05 7.2 +0.03" and "7.2 + 0.05 +0.03"
 * both normalise to the same result. Numbers written as the drawing
 * prints them keep their precision ("±0.170" stays 0.170).
 *
 * Returns null when neither the specification nor the value can be read
 * as a callout - callers then keep the original text untouched.
 */

const SYMBOLS = 'SØ|SR|Ø|⌀|∅|R|M|O|Q';

/* Symbol (optionally prefixed by a repetition count) directly in front
   of a number: "Ø7.2", "6X Ø5", "R10", "M8x1". */
const ANCHOR_RE = new RegExp(
  `(?:\\d+\\s*[xX×]\\s*)?(?:${SYMBOLS})\\s*(?=\\d)`,
  'i'
);

/* Same, anchored at the end of the text preceding the value. */
const PREFIX_RE = new RegExp(
  `((?:\\d+\\s*[xX×]\\s*)?(?:${SYMBOLS})\\s*)$`,
  'i'
);

const NUMBER_RE = /([+\-±]?)(\s*)(\d+(?:[.,]\d+)?|\.\d+)/g;

/* The degree sign is part of a suffix ("45° TYP"): without it a
   chamfer / angle note fails the charset test, the suffix is thrown
   away and the callout falls back to a bare number. */
const SUFFIX_CHARSET = /^(?:[A-Za-z0-9./\s°]+)$/;

const LONG_WORD_WHITELIST =
  /^(?:THRU|THROUGH|TYP|TYPICAL|DP|DEEP|MAX|MIN|REF|PLACES|ALL|EQSP|SP|PER|MM|IN|INCH|OR|AND)$/i;

/* Letters a value can be glued to without becoming a word code
   ("R10", "M8x1" are values - "H7", "x1" are codes). */
const VALUE_LETTERS = /[RrMm]/;

const clean = (value) =>
  String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();

const prepare = (raw) =>
  clean(raw)
    .replace(/[\u2212\u2013\u2014]/g, '-')
    .replace(/\uff0b/g, '+')
    .replace(/\u00c2\u00b1/g, '\u00b1')
    .replace(/(^|[\s(\[])[OQ](?=\s*\d)/gi, '$1\u00d8');

const scanNumbers = (text) => {
  const tokens = [];
  NUMBER_RE.lastIndex = 0;
  let match;
  while ((match = NUMBER_RE.exec(text)) !== null) {
    const signStart = match.index;
    const start = signStart + match[1].length + match[2].length;
    const raw = match[3];
    const token = {
      sign: match[1] === '\u00b1' ? '\u00b1' : match[1],
      num: raw.replace(',', '.'),
      signStart,
      start,
      end: start + raw.length
    };
    const previous = text[start - 1] || '';
    /* Numbers glued to a letter / digit / dot belong to a code
       (H7, x1, .0.5) rather than being a value of their own. */
    if (
      !match[1] &&
      /[A-Za-z0-9.]/.test(previous) &&
      !VALUE_LETTERS.test(previous)
    ) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
};

/* Unsigned candidates only count as tolerances when they look like
   one (0.05 / .05) - "15.90" or "11.0" are limits, not tolerances. */
const isToleranceToken = (token) => {
  if (token.sign) return Math.abs(Number(token.num)) < 1000;
  return /^(?:0+)\.\d+$/.test(token.num) || /^\.\d+$/.test(token.num);
};

const isValidSuffix = (raw) => {
  const suffix = raw.trim();
  if (!suffix) return true;
  if (suffix.length > 24) return false;
  if (!SUFFIX_CHARSET.test(suffix)) return false;
  /* Every digit must be part of a code such as H7 / x1 - a bare
     number means the text carries more than just the value.
     A number glued to a degree sign ("45°") is part of the callout,
     not prose, so it is allowed too. */
  const withoutCodes = suffix
    .replace(/[A-Za-z]\d+/g, '')
    .replace(/\d+\s*°/g, '');
  if (/\d/.test(withoutCodes)) return false;
  return withoutCodes
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => {
      const letters = word.replace(/[^A-Za-z]/g, '');
      return letters.length < 4 || LONG_WORD_WHITELIST.test(letters);
    });
};

const symbolFromType = (type) => {
  const value = String(type || '').toLowerCase();
  if (value.includes('diameter')) return '\u00d8';
  if (value.includes('radius')) return 'R';
  if (value.includes('thread')) return 'M';
  return '';
};

const deriveType = (symbol, suffix, text) => {
  const sym = String(symbol || '');
  if (/S\u00d8|\u00d8|\u2300|\u2205/.test(sym)) return 'Diameter';
  if (/SR|R/.test(sym)) return 'Radius';
  if (/M/.test(sym)) return 'Thread';
  /* A degree sign means this is an angle ("0.5x45° TYP"), never a fit. */
  if (
    suffix &&
    !suffix.includes('\u00b0') &&
    /^[A-Za-z]{1,2}\d{1,2}/.test(suffix)
  ) return 'Fit';
  if (String(text || '').includes('\u00b0')) return 'Angle';
  return 'Dimension';
};

/* Keep the precision the drawing used: "0.170" stays "0.170",
   ".05" becomes "0.05", a zero becomes "0.00". */
const formatTolerance = (rawText, number) => {
  const value = Number(number);
  if (!Number.isFinite(value) || Math.abs(value) < 1e-12) return '0.00';

  let text = clean(rawText)
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .replace(/^[+\-\u00b1]/, '');

  if (!/^\d*\.?\d+$/.test(text)) {
    return String(parseFloat(value.toFixed(4)));
  }
  if (text.startsWith('.')) text = `0${text}`;
  if (/^\d+(?:\.0*)?$/.test(text) && !text.includes('.')) {
    text = String(value);
  } else {
    text = text.replace(/^0+(?=\d)/, '');
  }
  return text;
};

/*
 * Parse a tolerance field ("+0.05", "0.050", "") into its numeric
 * value plus the text as it should be displayed.
 */
export const parseToleranceField = (value) => {
  const text = clean(value)
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .replace(/^\u00b1/, '');
  if (!text || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return { value: Math.abs(number), text: formatTolerance(text, number) };
};

/*
 * Split a stacked note that OCR/grouping merged into one string
 * back into its individual callouts.
 *
 *   "3 × 4.2 12 M5x0.8 10" -> ["3 × 4.2 12", "M5x0.8 10"]
 *   "4.2 12 3 x M5x0.8 10" -> ["4.2 12", "3 x M5x0.8 10"]
 *
 * A thread callout (M<d>...) that follows other content starts a
 * new characteristic; a note that is ONLY a thread callout
 * ("M5x0.8 10", "2 x M5 THRU") is never split. Returns the
 * original text as a single-element array when no split applies.
 */
export const splitCalloutText = (raw) => {
  const text = prepare(raw);
  if (!text) return [];

  const parts = [];
  let rest = text;

  for (let guard = 0; guard < 6; guard++) {
    /*
      Find the first thread token, together with an optional
      quantity directly in front of it ("3 x M5x0.8").
    */
    const match = rest.match(
      /(^|\s)(?:([1-9]\d*\s*[x\u00d7]\s+))?(M\s*\d)/i
    );
    if (!match) break;

    const splitStart = match.index + match[1].length;
    const left = rest.slice(0, splitStart).trim();

    /*
      Only split when the thread callout follows real content
      (a left part with digits of its own). A thread callout at
      the very start of the text is a single characteristic.
    */
    if (splitStart > 0 && /\d/.test(left)) {
      parts.push(left);
      rest = rest.slice(splitStart).trim();
    } else {
      break;
    }
  }

  if (parts.length === 0) return [text];
  if (rest) parts.push(rest);
  return parts.filter((p) => p);
};

/*
 * Parse one free-text callout. Never throws - a non-callout simply
 * comes back with confident: false.
 */
export const parseCalloutText = (raw) => {
  const text = prepare(raw);

  const parts = {
    text,
    symbol: '',
    nominal: '',
    nominalNum: NaN,
    suffix: '',
    tols: [],
    symmetric: null,
    symmetricText: null,
    upper: null,
    upperText: null,
    upperSign: '+',
    lower: null,
    lowerText: null,
    lowerSign: '-',
    hasTols: false,
    confident: false,
    type: 'Dimension'
  };

  if (!/\d/.test(text)) return parts;

  const tokens = scanNumbers(text);
  if (tokens.length === 0) return parts;

  /* ---- pick the nominal -------------------------------------- */
  let nominal = null;
  const anchor = ANCHOR_RE.exec(text);
  if (anchor) {
    const anchorEnd = anchor.index + anchor[0].length;
    nominal =
      tokens.find(
        (t) => t.start >= anchorEnd && t.start - anchorEnd <= 1
      ) || null;
  }
  if (!nominal) nominal = tokens.find((t) => !t.sign) || null;
  if (!nominal) return parts;

  parts.nominal = text.slice(nominal.start, nominal.end);
  parts.nominalNum = Number(parts.nominal);

  /* ---- symbol (and repetition count) before the value --------- */
  const prefix = text.slice(0, nominal.start);
  const prefixSymbol = PREFIX_RE.exec(prefix);
  let symbolSpan = null;
  if (prefixSymbol) {
    const beforeSymbol = text[prefixSymbol.index - 1] || '';
    /* "FORM 5" must not read as a thread - only accept a symbol that
       starts the text or sits behind a non-letter. */
    if (!/[A-Za-z]/.test(beforeSymbol)) {
      let symbol = prefixSymbol[1]
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
      if (symbol === 'O' || symbol === 'Q') symbol = '\u00d8';
      parts.symbol = symbol;
      symbolSpan = [prefixSymbol.index, prefix.length];
    }
  }

  /* ---- tolerances on either side of the value ----------------- */
  const tols = tokens
    .filter((t) => t !== nominal)
    .filter(isToleranceToken);
  parts.tols = tols.slice(0, 2);
  parts.hasTols = tols.length > 0;

  if (parts.tols.length) {
    const symmetricTol = parts.tols.find((t) => t.sign === '\u00b1');
    if (symmetricTol) {
      parts.symmetric = Number(symmetricTol.num);
      parts.symmetricText = symmetricTol.num;
      parts.upper = parts.symmetric;
      parts.upperText = symmetricTol.num;
      parts.lower = parts.symmetric;
      parts.lowerText = symmetricTol.num;
    } else if (parts.tols.length === 1) {
      const tol = parts.tols[0];
      const magnitude = Number(tol.num);
      if (tol.sign === '-') {
        parts.lower = magnitude;
        parts.lowerText = tol.num;
        parts.lowerSign = '-';
      } else if (tol.sign === '+') {
        parts.upper = magnitude;
        parts.upperText = tol.num;
        parts.upperSign = '+';
      } else {
        /* An unsigned single tolerance means the same value both
           ways (matches how stacked callouts are read). */
        parts.symmetric = magnitude;
        parts.symmetricText = tol.num;
        parts.upper = magnitude;
        parts.upperText = tol.num;
        parts.lower = magnitude;
        parts.lowerText = tol.num;
      }
    } else {
      let first = parts.tols[0];
      let second = parts.tols[1];
      if (first.sign === '-' && second.sign === '+') {
        const swap = first;
        first = second;
        second = swap;
      }
      parts.upper = Number(first.num);
      parts.upperText = first.num;
      parts.upperSign = first.sign === '-' ? '-' : '+';
      parts.lower = Number(second.num);
      parts.lowerText = second.num;
      parts.lowerSign = second.sign || '-';
    }
  }

  /* ---- text between the value and the next tolerance ----------- */
  const nextTolStart = parts.tols
    .map((t) => t.signStart)
    .filter((start) => start >= nominal.end)
    .sort((a, b) => a - b)[0];
  const suffixEnd = nextTolStart != null ? nextTolStart : text.length;
  const suffixCandidate = text.slice(nominal.end, suffixEnd);
  const suffixRange = isValidSuffix(suffixCandidate)
    ? [nominal.end, suffixEnd]
    : null;
  parts.suffix = suffixRange ? suffixCandidate.trim() : '';

  /* ---- every digit must belong to symbol / value / tolerance --- */
  const covered = (index) => {
    if (index >= nominal.start && index < nominal.end) return true;
    if (
      symbolSpan &&
      index >= symbolSpan[0] &&
      index < symbolSpan[1]
    ) {
      return true;
    }
    if (
      suffixRange &&
      index >= suffixRange[0] &&
      index < suffixRange[1]
    ) {
      return true;
    }
    return parts.tols.some(
      (t) => index >= t.start && index < t.end
    );
  };

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character >= '0' && character <= '9' && !covered(i)) {
      return parts;
    }
    /* Leftover words ("Check flatness 0.05", "FORM 5") mean this is
       prose, not a callout - leave it untouched. */
    if (/[A-Za-z]/.test(character) && !covered(i)) {
      return parts;
    }
  }

  parts.confident = true;
  parts.type = deriveType(parts.symbol, parts.suffix, text);
  return parts;
};

/*
 * Normalise a characteristic (or a raw detection) into the canonical
 * four fields. `prefer` decides which source wins when the stored
 * fields disagree with the specification text:
 *   'auto'   - value text first, tolerances from the specification,
 *              non-zero tolerance fields override mismatched values
 *   'spec'   - the specification text is being edited right now
 *   'fields' - the tolerance fields are being edited right now
 */
export const normalizeCallout = (input, options = {}) => {
  if (!input) return null;

  const prefer = options.prefer || 'auto';

  const specText = clean(
    input.specification != null ? input.specification : input.text
  );
  const valueText = clean(input.value);
  const fieldPlus = parseToleranceField(input.plusTolerance);
  const fieldMinus = parseToleranceField(input.minusTolerance);
  const inputType = clean(input.type);

  const specParts = specText ? parseCalloutText(specText) : null;
  const valueParts = valueText ? parseCalloutText(valueText) : null;

  const specOk = !!(specParts && specParts.confident);
  const valueOk = !!(valueParts && valueParts.confident);

  let base = null;
  if (prefer === 'spec') {
    base = specOk ? specParts : valueOk ? valueParts : null;
  } else {
    base = valueOk ? valueParts : specOk ? specParts : null;
  }
  if (!base) return null;

  const symbol =
    base.symbol ||
    (specParts && specParts.symbol) ||
    (valueParts && valueParts.symbol) ||
    symbolFromType(inputType);

  /* Tolerances: specification text first, then the value text. */
  let tolSource = null;
  if (specOk && specParts.tols.length) tolSource = specParts;
  else if (valueOk && valueParts.tols.length) tolSource = valueParts;

  let symmetric = tolSource ? tolSource.symmetric : null;
  let symmetricText = tolSource ? tolSource.symmetricText : null;
  let upper = tolSource ? tolSource.upper : null;
  let upperText = tolSource ? tolSource.upperText : null;
  let upperSign = tolSource ? tolSource.upperSign : '+';
  let lower = tolSource ? tolSource.lower : null;
  let lowerText = tolSource ? tolSource.lowerText : null;
  let lowerSign = tolSource ? tolSource.lowerSign : '-';

  const fieldsHaveTolerance =
    (fieldPlus != null && fieldPlus.value > 0) ||
    (fieldMinus != null && fieldMinus.value > 0);

  if (prefer === 'fields' && fieldsHaveTolerance) {
    /* The tolerance fields are being edited - their magnitude wins,
       the sign convention still comes from the specification. */
    symmetric = null;
    symmetricText = null;
    upper = fieldPlus && fieldPlus.value > 0 ? fieldPlus.value : null;
    upperText = fieldPlus && fieldPlus.value > 0 ? fieldPlus.text : null;
    upperSign = '+';
    lower = fieldMinus && fieldMinus.value > 0 ? fieldMinus.value : null;
    lowerText = fieldMinus && fieldMinus.value > 0 ? fieldMinus.text : null;
    if (upper != null && lower != null && upper === lower) {
      symmetric = upper;
      symmetricText = upperText;
    }
  } else if (prefer === 'auto') {
    /* Non-zero tolerance fields override values that disagree. */
    if (
      fieldPlus &&
      fieldPlus.value > 0 &&
      (upper == null || Math.abs(fieldPlus.value - upper) > 1e-9)
    ) {
      upper = fieldPlus.value;
      upperText = fieldPlus.text;
      upperSign = '+';
    }
    if (
      fieldMinus &&
      fieldMinus.value > 0 &&
      (lower == null || Math.abs(fieldMinus.value - lower) > 1e-9)
    ) {
      lower = fieldMinus.value;
      lowerText = fieldMinus.text;
      lowerSign = tolSource && tolSource.tols.length
        ? tolSource.lowerSign
        : '-';
    }
    if (!tolSource && upper != null && lower != null) {
      if (Math.abs(upper - lower) < 1e-9) {
        symmetric = upper;
        symmetricText = upperText;
      }
    }
  }

  /* An angular tolerance keeps its degree sign: "30° ±0.5°". */
  const angularTolerance = /\u00b1\s*\d+(?:\.\d+)?\s*\u00b0/.test(specText);

  const toleranceTexts = [];
  const tolSuffix = angularTolerance ? '\u00b0' : '';
  if (symmetric != null && symmetric > 0) {
    toleranceTexts.push(
      `\u00b1${formatTolerance(symmetricText, symmetric)}${tolSuffix}`
    );
  } else {
    if (upper != null && upper > 0) {
      toleranceTexts.push(
        `${upperSign}${formatTolerance(upperText, upper)}${tolSuffix}`
      );
    }
    if (lower != null && lower > 0) {
      toleranceTexts.push(
        `${lowerSign}${formatTolerance(lowerText, lower)}${tolSuffix}`
      );
    }
  }

  /* "Ø 7.2" reads better with the gap; engineers write "R10"/"M8". */
  const symbolGap = /(?:S\u00d8|\u00d8|\u2300|\u2205)$/.test(symbol)
    ? ' '
    : '';
  const core = symbol ? `${symbol}${symbolGap}${base.nominal}` : base.nominal;

  /* Keep the drawing's own spacing: "M8x1" stays together, "25 H7" keeps
     its gap - only insert one when the original text had a separator. */
  const gap = !!base.suffix &&
    !base.suffix.startsWith('\u00b0') &&
    !base.text.includes(`${base.nominal}${base.suffix}`);

  const full = base.suffix
    ? `${core}${gap ? ' ' : ''}${base.suffix}`
    : core;

  /*
    The value column holds the measured quantity, so the degree sign
    travels with it ("15°"). A fit or chamfer suffix ("H7", "TYP")
    is a modifier that stays in the specification only - matching
    how the value behaved before specification text was used as the
    source of truth.
  */
  const value = base.suffix && !base.suffix.includes('\u00b0')
    ? core
    : full;

  const specification = toleranceTexts.length
    ? `${full} ${toleranceTexts.join(' ')}`
    : full;

  let type = deriveType(symbol, base.suffix, base.text);
  if (type === 'Dimension' && inputType && inputType !== 'Dimension') {
    type = inputType;
  }

  let upperLimit =
    input.upperLimit != null ? String(input.upperLimit) : '0.00';
  let lowerLimit =
    input.lowerLimit != null ? String(input.lowerLimit) : '0.00';
  if (Number.isFinite(base.nominalNum)) {
    const plus = upper != null && upper > 0 ? upper : 0;
    const minus = lower != null && lower > 0 ? lower : 0;
    upperLimit = String(
      parseFloat((base.nominalNum + plus).toFixed(3))
    );
    lowerLimit = String(
      parseFloat((base.nominalNum - minus).toFixed(3))
    );
  }

  return {
    specification,
    value,
    plusTolerance: formatTolerance(upperText, upper != null ? upper : 0),
    minusTolerance: formatTolerance(lowerText, lower != null ? lower : 0),
    upperLimit,
    lowerLimit,
    type
  };
};

/*
 * Rebuild the specification after the value / tolerance fields were
 * edited by hand, keeping the sign conventions of the previous text.
 */
export const composeSpecification = (
  value,
  plusTolerance,
  minusTolerance,
  previousSpecification = ''
) => {
  const base = clean(value);
  const plus = parseToleranceField(plusTolerance);
  const minus = parseToleranceField(minusTolerance);
  const previous = previousSpecification
    ? parseCalloutText(previousSpecification)
    : null;

  const texts = [];
  const hasPlus = plus != null && plus.value > 0;
  const hasMinus = minus != null && minus.value > 0;

  if (
    hasPlus &&
    hasMinus &&
    plus.value === minus.value &&
    /*
      Show "±N" whenever the two tolerances match - including the
      first time they are set on a text that had no tolerances at
      all. Only a previously asymmetric tolerance text keeps the
      explicit "+ / -" form.
      */
    (previous == null || previous.symmetric != null || (previous.tols || []).length === 0)
  ) {
    texts.push(`\u00b1${formatTolerance(plus.text, plus.value)}`);
  } else {
    if (hasPlus) texts.push(`+${formatTolerance(plus.text, plus.value)}`);
    if (hasMinus) {
      const sign =
        previous && previous.tols.length ? previous.lowerSign : '-';
      texts.push(
        `${sign}${formatTolerance(minus.text, minus.value)}`
      );
    }
  }

  return texts.length ? `${base} ${texts.join(' ')}` : base;
};
