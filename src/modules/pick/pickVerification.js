// src/modules/pick/pickVerification.js
/**
 * PICK VERIFICATION — KIMS-WM API doc v2, Sections 2.11 and 2.12.
 *
 * One place for the rules, so both adapters (Business Central and demo)
 * and the Register gate read a pick's verification the same way.
 *
 * Flow:  Scan (picker, Take lines) → Verify (dispatch count, Place line)
 *        → Register.
 * A pick can only be registered once EVERY scanned group is verified at
 * exactly the scanned quantity:
 *
 *   Place qtyVerified = Place qtyToHandle = SUM(qtyToHandle of the group's
 *   Take lines)
 *
 * A GROUP is every Take and Place line with the same item / variant / lot /
 * serial (a bin split keeps these, so split Take lines stay in one group).
 *
 *   VERIFY (full) ........ for Register Pick: the whole outstanding pick is
 *                          scanned, and every group gets its count.
 *   PARTIAL VERIFY ....... for Partial Register Pick: every group scanned so
 *                          far gets its count; unscanned groups stay open.
 *
 * Both send a count for every scanned group — a scanned group left without
 * one blocks Register either way (status "Awaiting verification").
 */

const STATUS = Object.freeze({
  notScanned: 'Not scanned',
  awaiting: 'Awaiting verification',
  verified: 'Verified',
  under: 'Under-verified',
  over: 'Over-verified',
  verifiedWithoutScan: 'Verified without scan',
  outOfSync: 'Out of sync',
  exceedsOutstanding: 'Exceeds outstanding',
  noPlaceLine: 'No Place line',
  noTakeLine: 'No Take line',
});

/// Does this status stop Register (Section 2.11.7)?
function blocksRegister(status) {
  return status !== STATUS.notScanned && status !== STATUS.verified;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const txt = (v) => String(v == null ? '' : v).trim();

/// item|variant|lot|serial, trimmed and upper-cased — the key Business
/// Central pairs Take and Place lines by and carries over a bin split.
function groupKeyOf(line) {
  return [line.itemNo, line.variantCode, line.lotNo, line.serialNo].map((v) => txt(v).toUpperCase()).join('|');
}

function outstandingOf(line) {
  if (typeof line.qtyOutstanding === 'number') return line.qtyOutstanding;
  return Math.max(0, num(line.quantity) - num(line.qtyHandled));
}

/// The status of one group, from its figures (Section 2.11.7).
function statusOf(g) {
  if (g.takeCount === 0) return g.placeToHandle > 0 || g.verified > 0 ? STATUS.noTakeLine : STATUS.notScanned;
  if (g.exceedsOutstanding) return STATUS.exceedsOutstanding;
  if (g.scanned === 0) {
    return g.verified > 0 || g.placeToHandle > 0 ? STATUS.verifiedWithoutScan : STATUS.notScanned;
  }
  if (g.placeCount === 0) return STATUS.noPlaceLine;
  if (g.placeToHandle !== g.scanned) return STATUS.outOfSync;
  if (g.verified === 0) return STATUS.awaiting;
  if (g.verified === g.scanned) return STATUS.verified;
  return g.verified < g.scanned ? STATUS.under : STATUS.over;
}

/// What the operator is told about a group that blocks Register.
function problemOf(g) {
  const what = [g.sku, g.lotNo ? `lot ${g.lotNo}` : null, g.serialNo ? `serial ${g.serialNo}` : null]
    .filter(Boolean)
    .join(', ');
  switch (g.status) {
    case STATUS.awaiting:
      return `${what}: picked ${g.scanned}, not verified yet.`;
    case STATUS.under:
    case STATUS.over:
      return `${what}: picked ${g.scanned}, verified ${g.verified} — ${g.status}. Count again.`;
    case STATUS.verifiedWithoutScan:
      return `${what}: verified ${g.verified} but nothing is picked. Verify again with 0.`;
    case STATUS.outOfSync:
      return `${what}: Business Central's dispatch line holds ${g.placeToHandle} but ${g.scanned} is picked. Save the pick again to resync.`;
    case STATUS.exceedsOutstanding:
      return `${what}: more is set to handle than is outstanding. Correct the pick in Business Central.`;
    case STATUS.noPlaceLine:
      return `${what}: picked ${g.scanned} but the pick has no dispatch (Place) line for it.`;
    case STATUS.noTakeLine:
      return `${what}: the dispatch line has a quantity but no matching Take line.`;
    default:
      return `${what}: ${g.status}.`;
  }
}

/**
 * Builds a pick's verification from Business Central pick lines (Take and
 * Place, Section 2.5.1). Pure — no I/O.
 *
 * Returns {
 *   groups: [{ groupKey, sku, description, variantCode, lotNo, serialNo,
 *              isLotTracked, isSerialTracked, bins: [{ bin, qty }],
 *              outstanding, scanned, verified, placeToHandle,
 *              placeOutstanding, maxVerify, stagingBin, status,
 *              blocksRegister, placeLineIds }],
 *   summary: { scannedGroups, verifiedGroups, blockingGroups,
 *              scannedUnits, verifiedUnits, outstandingUnits, fullyScanned,
 *              readyForPartialRegister, readyForRegister, problems }
 * }
 */
function buildVerification(lines) {
  const byKey = new Map();
  const groupFor = (line) => {
    const key = groupKeyOf(line);
    let g = byKey.get(key);
    if (!g) {
      g = { key, takes: [], places: [] };
      byKey.set(key, g);
    }
    return g;
  };
  for (const line of lines || []) {
    if (line.actionType === 'Take') groupFor(line).takes.push(line);
    else if (line.actionType === 'Place') groupFor(line).places.push(line);
  }

  const groups = [];
  for (const raw of byKey.values()) {
    const takes = [...raw.takes].sort((a, b) => num(a.lineNo) - num(b.lineNo));
    const places = [...raw.places].sort((a, b) => num(a.lineNo) - num(b.lineNo));
    const sample = takes[0] || places[0];

    const binQty = new Map();
    for (const t of takes) {
      const q = num(t.qtyToHandle);
      if (q <= 0) continue;
      const bin = txt(t.binCode);
      binQty.set(bin, (binQty.get(bin) || 0) + q);
    }

    const g = {
      groupKey: raw.key,
      sku: sample.itemNo,
      description: (takes[0] && takes[0].itemDesc) || sample.itemDesc || '',
      variantCode: txt(sample.variantCode) || null,
      lotNo: txt(sample.lotNo) || null,
      serialNo: txt(sample.serialNo) || null,
      isLotTracked: (takes[0] || sample).isLotTracked === true,
      isSerialTracked: (takes[0] || sample).isSerialTracked === true,
      bins: [...binQty.entries()].map(([bin, qty]) => ({ bin, qty })),
      outstanding: takes.reduce((s, t) => s + outstandingOf(t), 0),
      scanned: takes.reduce((s, t) => s + num(t.qtyToHandle), 0),
      verified: places.reduce((s, p) => s + num(p.qtyVerified), 0),
      placeToHandle: places.reduce((s, p) => s + num(p.qtyToHandle), 0),
      placeOutstanding: places.reduce((s, p) => s + outstandingOf(p), 0),
      stagingBin: (places.find((p) => txt(p.binCode)) || {}).binCode || null,
      placeLineIds: places.map((p) => p.id).filter(Boolean),
      takeCount: takes.length,
      placeCount: places.length,
      exceedsOutstanding: takes.some((t) => num(t.qtyToHandle) > outstandingOf(t)),
      // Business Central's own status on the Place line, for diagnostics.
      bcStatus: (places[0] && places[0].verificationStatus) || null,
      _places: places,
    };
    // Nothing left and nothing in this round — the line is done.
    if (g.outstanding === 0 && g.scanned === 0 && g.verified === 0 && g.placeToHandle === 0) continue;
    g.status = statusOf(g);
    g.blocksRegister = blocksRegister(g.status);
    // The most the verifier may send (Section 2.11.3, rule 8).
    g.maxVerify = g.placeOutstanding;
    groups.push(g);
  }

  groups.sort((a, b) => String(a.sku).localeCompare(String(b.sku)) || a.groupKey.localeCompare(b.groupKey));
  return { groups, summary: summarize(groups) };
}

function summarize(groups) {
  const scanned = groups.filter((g) => g.scanned > 0);
  const blocking = groups.filter((g) => g.blocksRegister);
  const fullyScanned = groups.every((g) => g.outstanding === 0 || g.scanned >= g.outstanding);
  const readyForPartialRegister = scanned.length > 0 && blocking.length === 0;
  return {
    scannedGroups: scanned.length,
    verifiedGroups: groups.filter((g) => g.status === STATUS.verified).length,
    blockingGroups: blocking.length,
    scannedUnits: scanned.reduce((s, g) => s + g.scanned, 0),
    verifiedUnits: groups.reduce((s, g) => s + g.verified, 0),
    outstandingUnits: groups.reduce((s, g) => s + g.outstanding, 0),
    fullyScanned,
    readyForPartialRegister,
    readyForRegister: readyForPartialRegister && fullyScanned,
    problems: blocking.map(problemOf),
  };
}

/// The wire shape — internal fields dropped.
function publicGroup(g) {
  const { _places, takeCount, placeCount, exceedsOutstanding, ...rest } = g;
  return rest;
}

function publicVerification(v) {
  return { groups: v.groups.map(publicGroup), summary: v.summary };
}

/**
 * Checks a Verify / Partial Verify request against the pick's current
 * verification, and turns it into Business Central's verification entries
 * (Section 2.11.5: [{ id: <Place line id>, qtyVerified }]).
 *
 * counts: [{ groupKey, qtyVerified }]. qtyVerified is ABSOLUTE (a resend
 * replaces, so a retry is safe). A group with several Place lines gets the
 * count spread in line order, each up to its own Qty. to Handle, any excess
 * on the last — the same spread Business Central shows on Take lines.
 *
 * Throws { status, code, message } (plain object) on a broken rule; the
 * caller wraps it in its ApiError.
 */
function planVerification(verification, counts, { partial }) {
  const fail = (status, code, message) => {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    throw e;
  };
  if (!Array.isArray(counts) || counts.length === 0) {
    fail(400, 'BAD_REQUEST', 'counts must be a non-empty array of { groupKey, qtyVerified }.');
  }

  const { groups, summary } = verification;
  if (!partial && !summary.fullyScanned) {
    const short = groups
      .filter((g) => g.outstanding > 0 && g.scanned < g.outstanding)
      .map((g) => `${g.sku}${g.lotNo ? ` lot ${g.lotNo}` : ''}${g.serialNo ? ` serial ${g.serialNo}` : ''}: picked ${g.scanned} of ${g.outstanding}`);
    fail(
      409,
      'PICK_NOT_FULLY_PICKED',
      `Verify needs the whole pick picked first — ${short.join('; ')}. Use Partial Verify to verify what is picked so far.`,
    );
  }

  const byKey = new Map(groups.map((g) => [g.groupKey, g]));
  const seen = new Set();
  const problems = [];
  const entries = [];

  counts.forEach((c, i) => {
    const key = txt(c && c.groupKey).toUpperCase();
    const g = byKey.get(key);
    if (!g) {
      problems.push(`counts[${i}]: "${c && c.groupKey}" is not on this pick.`);
      return;
    }
    if (seen.has(key)) {
      problems.push(`counts[${i}]: ${g.sku} is counted twice.`);
      return;
    }
    seen.add(key);
    const qty = Number(c.qtyVerified);
    if (!Number.isInteger(qty) || qty < 0) {
      problems.push(`${g.sku}: the count must be a whole number of 0 or more (got ${c.qtyVerified}).`);
      return;
    }
    if (qty > 0 && g.scanned === 0) {
      problems.push(`${g.sku}: nothing is picked, so there is nothing to verify.`);
      return;
    }
    if (qty > g.maxVerify) {
      problems.push(`${g.sku}: count ${qty} is more than the ${g.maxVerify} outstanding.`);
      return;
    }
    if (g._places.length === 0) {
      problems.push(`${g.sku}: the pick has no dispatch (Place) line to verify against.`);
      return;
    }
    let left = qty;
    g._places.forEach((p, idx) => {
      const last = idx === g._places.length - 1;
      const share = last ? left : Math.min(left, num(p.qtyToHandle));
      left -= share;
      entries.push({ id: p.id, qtyVerified: share });
    });
  });

  const missing = groups.filter((g) => g.scanned > 0 && !seen.has(g.groupKey));
  if (missing.length > 0) {
    problems.push(
      `Count every picked item before verifying — missing: ${missing
        .map((g) => `${g.sku}${g.lotNo ? ` lot ${g.lotNo}` : ''}${g.serialNo ? ` serial ${g.serialNo}` : ''}`)
        .join(', ')}.`,
    );
  }
  if (problems.length > 0) fail(400, 'PICK_VERIFY_INVALID', problems.join(' '));
  return entries;
}

module.exports = {
  STATUS,
  blocksRegister,
  groupKeyOf,
  statusOf,
  buildVerification,
  summarize,
  publicVerification,
  planVerification,
};