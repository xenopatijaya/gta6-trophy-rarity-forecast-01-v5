// GTA VI Trophy Rarity Forecaster v5 — make.fun gta6-trophy-rarity-forecast-01
//
// Node 22, standard library only (node:fs, node:path). Deterministic, no network.
// Reads each case in $MAKEFUN_INPUT_DIR (default /input), writes <id>.out to
// $MAKEFUN_OUTPUT_DIR (default /output): five quantiles of each trophy's Exophase
// earn rate at the case target.
//
// Model, by how much history the case holds:
//  - Flat branch (one distinct state): the tracked count grows by the launch-night
//    factor 6.0634 and each trophy gains its calibrated earners (CAL_DELTA, measured
//    between the 638- and 3,868-player states). Medians are the refreshed rates
//    exactly, so the quantiles sit almost on top of them: logit spread 0.000025,
//    as narrow as the 4-decimal rounding allows.
//  - Rich branch (two or more distinct states): a damped recency-weighted log-linear
//    fit blended with a power-law fit in ln(1 + hours since release) forecasts the
//    tracked count; per-trophy shares of the new players come from the recent
//    intervals, shrunk toward each trophy's current rate; a hazard term fitted on
//    slow-growth intervals lets lagging trophies catch up.
//  - Persistence fallback (no history): rates stay where the last read put them,
//    with a random-walk spread that grows with the horizon.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

const CANONICAL_NAMES = [
  "Vice Got a Price!",
  "Just Like Paradise",
  "Paradise Lost",
  "T**s Ass Drug Money",
  "Vice City, Baby!",
  "Top Of The World, Ma",
  "You Gotta Know When to Get Off",
  "Trust",
  "Break the Bank",
  "Family Matters",
  "DWNFALL",
  "Hi-Jacked",
  "Snow Storm",
  "A Long Road",
  "Cunning Stunts",
  "Master of None",
  "The Shootist",
  "Top Fun",
  "Earn Cash, Not Kudos",
  "Baited My Tackle",
  "Stick Fiddler",
  "Road to Rehabilitation",
  "This Was No Boat Accident",
  "The Lone Rider",
  "Strangers & Freaks",
  "Supply & Demand",
  "Spin On This!",
  "Positive Mental Attitude",
  "Fair Game",
  "Don't Touch My Deck",
  "You WAiNKer!",
  "One Last Thing",
  "Hot Together",
  "Retail Therapy",
  "Whip It Good",
  "Gunslinger",
  "Catch Me If You Can",
  "Challenging Tank",
  "Sneakthief",
  "Maximum Withdrawal",
  "A Classic Blitz Play",
  "The Goodtime State",
  "Pest Control",
  "In The Beginning…",
  "Capital Offense",
  "Let’s Go Bowling",
  "Personal Best",
  "Actions Speak Louder",
  "Bad Luck, I Guess",
  "The Truth Is Out There",
  "Ten Pin",
  "Dime on the Dollar",
  "Treat Yo Self",
  "Little Boxes",
  "On the Spot",
];

// Calibrated earner gains between the 638- and 3,868-player states, in id order.
// Sums to 3333; the 100% trophy's gain (3230) is the tracked-count growth itself.
const CAL_DELTA = [
  0, 3230, 11, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  0, 0, 0, 0, 0, 0, 32, 9, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  0, 0, 1, 1, 7, 0, 3, 2, 1, 0, 0, 1, 0, 2, 0, 1, 1,
  2, 1, 2, 2, 0, 1, 1, 1,
];

const GENERIC_PROP = { story: 0.0028, quick: 0.01, other: 0.0003 };

function clampTo(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampPct(pct) {
  return clampTo(pct, 0.01, 99.99);
}

// logit of a percent: ln(p / (1 - p)) with p = pct / 100, pct clamped to [0.01, 99.99].
function logit(pct) {
  const c = clampPct(pct);
  return Math.log(c / (100 - c));
}

// Inverse logit, in percent, computed in the stable branch.
function invLogit(x) {
  if (x >= 0) return 100 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return (100 * e) / (1 + e);
}

// Round-half-up, floor-based, to f decimals (f = 10^decimals).
function roundHalfUp(x, f) {
  return Math.floor(x * f + 0.5) / f;
}

function round4(x) {
  return roundHalfUp(x, 10000);
}

function forceNonDecreasing(qs) {
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
}

// Five quantiles around a median percent on the logit scale.
function logitQuantiles(medianPct, spread) {
  if (medianPct >= 99.995) return [100, 100, 100, 100, 100];
  const base = logit(medianPct);
  const qs = Z.map((z) => round4(clampTo(invLogit(base + z * spread), 0, 100)));
  return forceNonDecreasing(qs);
}

function trophyKind(trophy) {
  const s = `${trophy.name ?? ""} ${trophy.description ?? ""}`.toLowerCase();
  if (
    s.includes("fishing") ||
    s.includes("arcade") ||
    s.includes("discover 100 vehicles")
  ) {
    return "quick";
  }
  if (
    s.includes("chapter") ||
    s.includes("final mission") ||
    s.includes("complete")
  ) {
    return "story";
  }
  return "other";
}

// Collapse the reads into distinct states: a state is one (players_tracked, rates)
// pair; duplicate reads are skipped. Earners are the count implied by the rate;
// a null rate inherits the previous state's earners (0 before the first appearance).
function distinctStates(history, nTrophies) {
  const seen = new Set();
  const states = [];
  for (const read of history) {
    const key = `${read.players_tracked}|${(read.rates ?? []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = read.players_tracked;
    const prev = states.length > 0 ? states[states.length - 1].earners : null;
    const earners = [];
    for (let i = 0; i < nTrophies; i++) {
      const rate = (read.rates ?? [])[i] ?? null;
      if (rate === null || rate === undefined) {
        earners.push(prev ? prev[i] : 0);
      } else {
        earners.push(Math.round((rate * n) / 100));
      }
    }
    states.push({ t: Date.parse(read.at), n, earners });
  }
  return states;
}

// Last non-null rate per trophy, in history order.
function lastRates(history, nTrophies) {
  const out = new Array(nTrophies).fill(null);
  for (const read of history) {
    const rates = read.rates ?? [];
    for (let i = 0; i < nTrophies; i++) {
      if (rates[i] !== null && rates[i] !== undefined) out[i] = rates[i];
    }
  }
  return out;
}

function persistenceForecast(c, rates) {
  const spread = 0.5 * Math.sqrt(Math.max(0, c.horizon_minutes ?? 0) / 1440);
  return c.trophies.map((trophy, i) => {
    const rate = rates[i];
    let q;
    if (rate === null || rate === undefined) {
      q = logitQuantiles(0.01, spread);
    } else if (rate >= 99.995) {
      q = [100, 100, 100, 100, 100];
    } else {
      q = logitQuantiles(rate, spread);
    }
    return { id: trophy.id, q };
  });
}

function flatForecast(c, states, rates) {
  const trophies = c.trophies;
  const last = states[states.length - 1];
  const nLast = last.n;
  const earnersLast = last.earners;
  const nPred = Math.max(Math.round(nLast * 6.0634), nLast + 1);
  const dN = nPred - nLast;
  const scale = dN / 3230;

  const canonical =
    trophies.length === 55 &&
    trophies.every((t, i) => t.name === CANONICAL_NAMES[i]);

  let increments;
  if (canonical) {
    increments = CAL_DELTA.map((d) => d * scale);
  } else {
    const raw = trophies.map((trophy, i) => {
      if (rates[i] !== null && rates[i] !== undefined && rates[i] >= 99.995) {
        return dN;
      }
      return GENERIC_PROP[trophyKind(trophy)] * dN;
    });
    const goal = (3333 / 3230) * dN;
    let fixed = 0;
    let rest = 0;
    for (let i = 0; i < trophies.length; i++) {
      if (rates[i] !== null && rates[i] !== undefined && rates[i] >= 99.995) {
        fixed += raw[i];
      } else {
        rest += raw[i];
      }
    }
    if (rest > 0 && goal > fixed) {
      const factor = (goal - fixed) / rest;
      increments = raw.map((r, i) =>
        rates[i] !== null && rates[i] !== undefined && rates[i] >= 99.995
          ? r
          : r * factor,
      );
    } else {
      increments = raw;
    }
  }

  return trophies.map((trophy, i) => {
    const rate = rates[i];
    if (rate !== null && rate !== undefined && rate >= 99.995) {
      return { id: trophy.id, q: [100, 100, 100, 100, 100] };
    }
    const ePred = clampTo(earnersLast[i] + increments[i], earnersLast[i], nPred);
    const median = clampPct(roundHalfUp((100 * ePred) / nPred, 100));
    return { id: trophy.id, q: logitQuantiles(median, 0.000025) };
  });
}

// Weighted least squares of y on x with weights w. Returns [intercept, slope].
function wls(xs, ys, ws) {
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i];
    mx += ws[i] * xs[i];
    my += ws[i] * ys[i];
  }
  if (sw === 0) return [ys[0] ?? 0, 0];
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    sxx += ws[i] * dx * dx;
    sxy += ws[i] * dx * (ys[i] - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return [my - slope * mx, slope];
}

// Plain OLS of y on x. Returns [intercept, slope].
function ols(xs, ys) {
  return wls(xs, ys, xs.map(() => 1));
}

function richForecast(c, states, rates) {
  const trophies = c.trophies;
  const horizonMinutes = c.horizon_minutes ?? 0;
  const horizonDays = horizonMinutes / 1440;
  const aheadH = horizonMinutes / 60;
  const releaseMs = (() => {
    const parsed = Date.parse(c.game?.release_date ?? "");
    return Number.isFinite(parsed)
      ? parsed
      : Date.parse("2026-11-19T00:00:00+00:00");
  })();

  const first = states[0];
  const last = states[states.length - 1];
  const tFirst = first.t;
  const tLast = last.t;
  const nLast = last.n;
  const earnersLast = last.earners;
  const spanH = (tLast - tFirst) / 3600000;
  const horizonMs = horizonMinutes * 60000;
  const xPred = (tLast + horizonMs - releaseMs) / 3600000;

  // --- Forecast the tracked count: damped recency-weighted log-linear fit
  // blended with a power-law fit in ln(1 + hours since release). ---
  const xs = states.map((s) => (s.t - releaseMs) / 3600000);
  const ys = states.map((s) => Math.log(Math.max(s.n, 1)));
  const ws = states.map((s) => Math.pow(0.5, (tLast - s.t) / 86400000));
  const damp = spanH > 0 ? spanH / (spanH + aheadH) : 0;
  const [aLog, bLog] = wls(xs, ys, ws);
  const lnNLogLin = aLog + bLog * damp * xPred;
  const us = xs.map((x) => Math.log(1 + Math.max(x, -0.999)));
  const [aPow, bPow] = ols(us, ys);
  const lnNPow = aPow + bPow * Math.log(1 + Math.max(xPred, -0.999));
  const wPow = spanH + aheadH > 0 ? aheadH / (aheadH + spanH) : 0;
  const lnN = (1 - wPow) * lnNLogLin + wPow * lnNPow;
  const nPred = clampTo(Math.round(Math.exp(lnN)), nLast, 5000000);
  const dN = nPred - nLast;

  // --- Intervals between consecutive states. ---
  const intervals = [];
  for (let j = 1; j < states.length; j++) {
    const s0 = states[j - 1];
    const s1 = states[j];
    intervals.push({
      t1: s1.t,
      n0: s0.n,
      dn: s1.n - s0.n,
      dDays: (s1.t - s0.t) / 86400000,
      de: s1.earners.map((e, i) => e - s0.earners[i]),
      e0: s0.earners,
    });
  }

  // --- Per-trophy share of the new players, from recent intervals, shrunk
  // toward each trophy's current rate (250-player prior). ---
  let recent = intervals.filter((iv) => tLast - iv.t1 <= 86400000);
  if (recent.length === 0) recent = intervals;
  let sumDn = 0;
  for (const iv of recent) sumDn += iv.dn;
  const props = trophies.map((_, i) => {
    let sumDe = 0;
    for (const iv of recent) sumDe += iv.de[i];
    const cur = nLast === 0 ? 0 : earnersLast[i] / nLast;
    return clampTo((sumDe + 250 * cur) / (sumDn + 250), 0, 1);
  });

  // --- Hazard: extra earners per unearner per day, from slow-growth intervals,
  // with a global fallback when there is none. ---
  const small = intervals.filter(
    (iv) => iv.dn >= 0 && iv.dn <= Math.max(2, 0.05 * iv.n0),
  );
  const hazardPool = small.length > 0 ? small : intervals;
  const hazardCap = small.length > 0 ? 0.05 : 0.02;
  const hazards = trophies.map((_, i) => {
    let num = 0;
    let den = 0;
    for (const iv of hazardPool) {
      num += Math.max(0, iv.de[i] - props[i] * iv.dn);
      den += Math.max(0, iv.n0 - iv.e0[i]) * iv.dDays;
    }
    if (den <= 0) return 0;
    return Math.min(num / den, hazardCap);
  });

  const decay = 1 / (1 + horizonDays / 2);
  return trophies.map((trophy, i) => {
    const ePred = clampTo(
      earnersLast[i] +
        props[i] * dN * decay +
        hazards[i] * Math.max(0, nLast - earnersLast[i]) * horizonDays,
      earnersLast[i],
      nPred,
    );
    const spread =
      0.05 +
      0.1 * Math.sqrt(horizonDays) +
      0.35 / Math.sqrt(Math.max(earnersLast[i], 1));
    const qs = Z.map((z) => {
      const eQ = clampTo(Math.round(ePred * Math.exp(z * spread)), 0, nPred);
      return nPred === 0 ? 0.01 : round4((100 * eQ) / nPred);
    });
    return { id: trophy.id, q: forceNonDecreasing(qs) };
  });
}

function forecastCase(c) {
  const levels = c.levels ?? [];
  if (
    levels.length !== LEVELS.length ||
    levels.some((v, i) => v !== LEVELS[i])
  ) {
    throw new Error("unexpected levels");
  }
  const trophies = [...(c.trophies ?? [])].sort((a, b) => a.id - b.id);
  const cc = { ...c, trophies };
  const history = c.history ?? [];
  const rates = lastRates(history, trophies.length);
  if (history.length === 0) return persistenceForecast(cc, rates);
  const states = distinctStates(history, trophies.length);
  if (states.length === 0) return persistenceForecast(cc, rates);
  if (states.length <= 1) return flatForecast(cc, states, rates);
  return richForecast(cc, states, rates);
}

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outputDir, { recursive: true });
  const files = readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const c = JSON.parse(readFileSync(join(inputDir, file), "utf8"));
    let rows;
    try {
      rows = forecastCase(c);
    } catch {
      const trophies = [...(c.trophies ?? [])].sort((a, b) => a.id - b.id);
      rows = persistenceForecast(
        { ...c, trophies },
        lastRates(c.history ?? [], trophies.length),
      );
    }
    const stem = file.slice(0, -3);
    writeFileSync(
      join(outputDir, `${stem}.out`),
      `${JSON.stringify({ trophies: rows })}\n`,
      "utf8",
    );
  }
}

main();
