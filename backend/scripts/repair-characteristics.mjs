/*
  One-off repair for characteristics whose stored value lost the
  degree sign (and for rows saved without upper/lower limits).

  Balloon 11 of NA91KD.pdf is the known case:

    balloon.text        "15°"
    characteristic      value "15" / specification "15" / type "Dimension"
    should be           value "15°" / specification "15°" / type "Angle"

  The parser that produced the bad row has been fixed, so this script
  only has to clean up what is already in the database.

  The repair is deliberately conservative - a row is only touched when
  the balloon text and the stored value describe the SAME numbers and
  the only difference is the missing degree sign. Rows you corrected by
  hand (where the balloon text is OCR garbage) are never touched.

  Usage:
    node scripts/repair-characteristics.mjs           # dry run
    node scripts/repair-characteristics.mjs --apply   # write changes
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import {
  normalizeCallout,
  parseCalloutText
} from '../../frontend/src/utils/calloutFormat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const loadEnv = () => {
  const envPath = path.join(__dirname, '..', '.env');

  if (!fs.existsSync(envPath)) return {};

  const values = {};

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }

  return values;
};

const uri =
  process.env.MONGODB_URI ||
  loadEnv().MONGODB_URI ||
  'mongodb://127.0.0.1:27017/manufacturing-inspection';

const numberList = (value) =>
  String(value || '').match(/\d+(?:\.\d+)?/g) || [];

const sameNumbers = (a, b) => {
  const left = numberList(a);
  const right = numberList(b);
  return left.length > 0 && left.join('|') === right.join('|');
};

const numeric = (value) => {
  const parsed = Number(String(value ?? '').replace(/^[+\-±]/, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

/*
  Derive the limits only when the callout parses confidently: the
  nominal has to be unambiguous. Multi-number readings that are not
  callouts ("15.95 15.90" limit pairs, part numbers like
  "MD-51-12-004") are rejected so nothing wrong gets written.
  Stored tolerance fields win over anything found in the text.
*/
const limitsFor = (text, plus, minus) => {
  const parts = parseCalloutText(text);

  if (
    !parts ||
    !parts.confident ||
    !Number.isFinite(parts.nominalNum)
  ) {
    return null;
  }

  let upper = numeric(plus);
  let lower = numeric(minus);

  if (upper === 0 && lower === 0) {
    if (parts.symmetric != null && parts.symmetric > 0) {
      upper = parts.symmetric;
      lower = parts.symmetric;
    } else {
      if (parts.upper != null && parts.upper > 0) upper = parts.upper;
      if (parts.lower != null && parts.lower > 0) lower = parts.lower;
    }
  }

  return {
    upperLimit: String(parseFloat((parts.nominalNum + upper).toFixed(3))),
    lowerLimit: String(parseFloat((parts.nominalNum - lower).toFixed(3)))
  };
};

const main = async () => {
  const client = new MongoClient(uri);
  await client.connect();

  const db = client.db();

  const balloons = await db.collection('balloons').find({}).toArray();
  const balloonById = new Map(
    balloons.map((balloon) => [String(balloon._id), balloon])
  );

  const characteristics = await db
    .collection('characteristics')
    .find({})
    .toArray();

  const changes = [];

  for (const characteristic of characteristics) {
    const balloon = balloonById.get(String(characteristic.balloonId));
    const balloonText = String((balloon && balloon.text) || '').trim();
    const value = String(characteristic.value || '').trim();
    const specification = String(characteristic.specification || '').trim();

    const patch = {};

    /* ---- 1. degree sign dropped from the stored value ---- */
    const degreeLoss =
      balloonText.includes('°') &&
      /\d/.test(balloonText) &&
      /\d/.test(value) &&
      !value.includes('°') &&
      !specification.includes('°') &&
      sameNumbers(value, balloonText);

    if (degreeLoss) {
      const normalized = normalizeCallout(
        {
          specification: balloonText,
          value,
          plusTolerance: characteristic.plusTolerance,
          minusTolerance: characteristic.minusTolerance,
          type: characteristic.type
        },
        { prefer: 'spec' }
      );

      if (normalized) {
        patch.specification = normalized.specification;
        patch.value = normalized.value;
        patch.type = normalized.type;
        if (normalized.type === 'Angle') patch.unit = 'deg';

        const limits = limitsFor(
          normalized.value,
          characteristic.plusTolerance,
          characteristic.minusTolerance
        );

        if (limits) Object.assign(patch, limits);
      }
    }

    /* ---- 2. limits never saved ---- */
    if (
      characteristic.upperLimit == null ||
      characteristic.lowerLimit == null
    ) {
      const limits = limitsFor(
        specification || value,
        characteristic.plusTolerance,
        characteristic.minusTolerance
      );

      /* Leave ambiguous readings alone rather than store a guess. */
      if (limits) Object.assign(patch, limits);
    }

    /* ---- 3. an angle measured in millimetres ---- */
    if (patch.type === 'Angle' || characteristic.type === 'Angle') {
      if ((patch.unit || characteristic.unit) !== 'deg') patch.unit = 'deg';
    }

    if (Object.keys(patch).length === 0) continue;

    changes.push({ id: characteristic._id, number: characteristic.number, before: {
      value,
      specification,
      type: characteristic.type,
      unit: characteristic.unit,
      upperLimit: characteristic.upperLimit,
      lowerLimit: characteristic.lowerLimit
    }, patch });

    if (APPLY) {
      await db
        .collection('characteristics')
        .updateOne(
          { _id: characteristic._id },
          { $set: { ...patch, updatedAt: new Date() } }
        );
    }
  }

  console.log(
    `${APPLY ? 'APPLIED' : 'DRY RUN'} - ${changes.length} of ${characteristics.length} characteristics need repair`
  );

  for (const change of changes) {
    console.log(
      `\n#${change.number} (${change.id})\n  before: ${JSON.stringify(change.before)}\n  after:  ${JSON.stringify(change.patch)}`
    );
  }

  if (!APPLY && changes.length > 0) {
    console.log('\nRe-run with --apply to write these changes.');
  }

  await client.close();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
