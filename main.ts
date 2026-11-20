/**
 * Forecast each GTA VI trophy's Exophase earn rate a week after launch.
 *
 * The rate a page prints is earners / players-tracked, and the two sides move for
 * different reasons. Exophase does not drift: the page sits frozen for hours and
 * then jumps at a refresh. On launch night every read from 23:48Z to 04:00Z was
 * the same page (638 tracked, 943 earned), then one refresh put 3,868 tracked and
 * 4,276 earned on it and every rate but the 100% one fell, and by 27.3 h the page
 * held 14,028 tracked and 14,882 earned. Fitting the rate alone reads those steps
 * as noise around a trend. Splitting the rate reads them as what they are: the
 * denominator moved, and the numerator moved far less.
 *
 * So the forecast works on the two sides separately.
 *
 *   pool(t)      : the players Exophase tracks for the game
 *   earners_i(t) : rate_i(t)/100 * pool(t), the players holding trophy i
 *
 * The pool is fitted on log(1 + hours since release), weighted to the recent
 * reads and pivoted at the last one so a bad slope cannot move today's level.
 * Each trophy's earners are fitted on the pool itself:
 *
 *   log earners_i = log earners_i(last) + gamma_i * log(pool(t)/pool(last))
 *
 * gamma_i is the trophy's own dilution exponent: 0 means its holders are already
 * fixed and its rate is pure dilution, 1 means it grows with the pool and its
 * rate never moves. Measured across the one real interval available (638 to
 * 14,028 tracked, a 22x pool) the field's gamma runs from -0.02 to 1.00 with a
 * median of 0.05, so most trophies are near pure dilution and the field's mean
 * is 0.156.
 *
 * gamma is estimated per trophy from the case's own history whenever the history
 * holds more than one distinct page, shrunk toward the pooled value by how many
 * transitions actually support it: with two points a single trophy's exponent is
 * mostly noise, and the pooled estimate is the better bet. That shrinkage is what
 * the practice cases cannot test (their histories are one flat page) and what the
 * final case can, because by the deadline the recorder will have written ~2.5
 * days of reads with several real refreshes in them.
 *
 * Everything is deterministic: the house runs each case twice and compares the
 * bytes, so nothing here may vary run to run.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

type Read = {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: (number | null)[];
};

type Trophy = { id: number; name: string; tier: string; points: number; secret: boolean };

type Case = {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string };
  trophies: Trophy[];
  history: Read[];
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The five quantile levels the house asks for, in order. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

const RATE_FLOOR = 0.01;
const RATE_CEIL = 99.99;
const MIN_SPREAD = 0.05;
const MAX_SPREAD = 5.0;          // the house's own ceiling (GTA6_TROPHIES_SPREAD_MAX)

/** Genuine drift of a rate's logit per sqrt(day), the house's own baseline scale. */
const WALK_PER_DAY = 0.5;

/**
 * The pool's log-log slope when the history cannot supply one. Measured on the
 * house's own recording of the first day, where the pool went 638 tracked at
 * 2.5 h to 3,868 at 4.5 h and 14,028 by 27.3 h: the slope starts near 3.0 across
 * the launch spike and settles near 0.7 across the following day. A forecast made
 * far from launch therefore wants the settled value, not the spike.
 */
const POOL_SLOPE_FALLBACK = 0.62;
const POOL_SLOPE_MIN = 0.10;
const POOL_SLOPE_MAX = 1.60;

/**
 * The field's dilution exponent, measured over 638 -> 14,028 tracked: the mean
 * gamma is 0.156 and its spread across trophies is 0.237. A trophy with no
 * usable history of its own starts here.
 */
const GAMMA_POOLED = 0.156;
const GAMMA_SD_POOLED = 0.237;

/** How many transitions a trophy needs before its own gamma outweighs the pool. */
const GAMMA_SHRINK_K = 2.0;

/** The share of a rate's logit movement that a refresh leaves unexplained. */
const REFRESH_ALLOWANCE = 0.10;

function hoursFrom(release: string, at: string): number {
  const t = Date.parse(at) - Date.parse(release);
  return t / HOUR_MS;
}

function clampRate(x: number): number {
  if (!Number.isFinite(x)) return RATE_FLOOR;
  return Math.min(Math.max(x, RATE_FLOOR), RATE_CEIL);
}

function logit(rate: number): number {
  const c = clampRate(rate) / 100;
  return Math.log(c / (1 - c));
}

function invLogit(x: number): number {
  const z = Math.max(Math.min(x, 30), -30);
  return clampRate((100 / (1 + Math.exp(-z))));
}

/** The distinct pages a history holds, in order: a repeated read adds no slope. */
function distinctPages(history: Read[]): Read[] {
  const out: Read[] = [];
  for (const r of history) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.players_tracked === r.players_tracked &&
      prev.trophies_earned === r.trophies_earned &&
      prev.rates.length === r.rates.length &&
      prev.rates.every((v, i) => v === r.rates[i])
    ) {
      continue;
    }
    out.push(r);
  }
  return out;
}

/** Weights that favour the recent reads: the pool's slope decays with age. */
function recencyWeights(n: number, halfLife: number): number[] {
  const ws: number[] = [];
  for (let i = 0; i < n; i++) {
    const age = n - 1 - i;
    ws.push(Math.pow(0.5, age / halfLife));
  }
  return ws;
}

/** A weighted straight line, returned with the weighted residual sd. */
function fitLine(xs: number[], ys: number[], ws: number[]): { a: number; b: number; sd: number } {
  let sw = 0;
  let swx = 0;
  let swy = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i];
    swx += ws[i] * xs[i];
    swy += ws[i] * ys[i];
  }
  if (sw <= 0) return { a: 0, b: 0, sd: 0 };
  const mx = swx / sw;
  const my = swy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += ws[i] * (xs[i] - mx) * (xs[i] - mx);
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  let sw2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const e = ys[i] - (a + b * xs[i]);
    ss += ws[i] * e * e;
    sw2 += ws[i];
  }
  const sd = xs.length > 2 ? Math.sqrt(ss / sw2) : 0;
  return { a, b, sd };
}

/** The pool's log-log slope, read from the history when it holds a slope. */
function poolSlope(pages: Read[], release: string): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of pages) {
    if (!(r.players_tracked > 0)) continue;
    const h = hoursFrom(release, r.at);
    if (!Number.isFinite(h) || h <= 0) continue;
    xs.push(Math.log1p(h));
    ys.push(Math.log(r.players_tracked));
  }
  if (xs.length < 2) return POOL_SLOPE_FALLBACK;
  const ws = recencyWeights(xs.length, 2.0);
  const { b } = fitLine(xs, ys, ws);
  if (!Number.isFinite(b)) return POOL_SLOPE_FALLBACK;
  return Math.min(Math.max(b, POOL_SLOPE_MIN), POOL_SLOPE_MAX);
}

/**
 * One trophy's dilution exponent from the case's own transitions: a weighted
 * regression of log(earners) on log(pool) across the distinct pages, pivoted so
 * the last page is exact. Shrunk toward the pooled value by the number of
 * transitions that support it, so a two-point history cannot run away.
 */
function trophyGamma(
  pages: Read[],
  index: number,
  pooled: number,
): { gamma: number; points: number; residual: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of pages) {
    const rate = r.rates[index];
    if (rate === null || !Number.isFinite(rate)) continue;
    if (!(r.players_tracked > 0)) continue;
    const e = (clampRate(rate) / 100) * r.players_tracked;
    if (!(e > 0)) continue;
    xs.push(Math.log(r.players_tracked));
    ys.push(Math.log(e));
  }
  if (xs.length < 2) return { gamma: pooled, points: 0, residual: GAMMA_SD_POOLED };

  const ws = recencyWeights(xs.length, 2.0);
  const { b, sd } = fitLine(xs, ys, ws);
  const n = xs.length - 2;
  const w = n / (n + GAMMA_SHRINK_K);
  const own = Number.isFinite(b) ? b : pooled;
  // A gamma outside [0, 1] says the holders fall, or grow faster than the pool.
  // Both happen in a 22x interval's noise, but neither is a law to extrapolate.
  const gamma = Math.min(Math.max(w * own + (1 - w) * pooled, -0.05), 1.05);
  return { gamma, points: n, residual: sd };
}

/** One case's rows: each trophy's five quantiles at the case's target. */
function forecast(c: Case): { id: number; q: number[] }[] {
  const release = c.game.release_date;
  const targetHours = hoursFrom(release, c.target);
  const history = c.history;
  const pages = distinctPages(history);
  const last = history[history.length - 1];
  const lastH = hoursFrom(release, last.at);
  const lastPool = Math.max(last.players_tracked, 1);

  // The pool at the target, from the last page and the fitted slope.
  const b = poolSlope(pages, release);
  const span = Math.log1p(Math.max(targetHours, 0)) - Math.log1p(Math.max(lastH, 0));
  const poolRatio = Math.exp(b * span);
  const poolTarget = lastPool * poolRatio;

  // The horizon's length sets how much genuine drift the spread must cover.
  const horizonDays = Math.max(c.horizon_minutes / 1440, 1 / 24);
  const walk = WALK_PER_DAY * Math.sqrt(horizonDays);

  const rows: { id: number; q: number[] }[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const trophy = c.trophies[i];

    // The trophy's holders on the last page that printed its rate.
    let lastRate = RATE_FLOOR;
    let lastEarners = 0;
    for (let k = history.length - 1; k >= 0; k--) {
      const rate = history[k].rates[i];
      if (rate === null || !Number.isFinite(rate)) continue;
      lastRate = clampRate(rate);
      lastEarners = (lastRate / 100) * Math.max(history[k].players_tracked, 1);
      break;
    }

    // A trophy at 100% is a structural fact, not a fit: every player Exophase
    // tracks has it because they had to start the game to be tracked at all. Its
    // holders therefore ARE the pool, so its gamma is exactly 1 and its rate
    // stays at the ceiling however far the pool grows.
    const saturated = lastRate >= 99.5;
    const { gamma, points, residual } = saturated
      ? { gamma: 1.0, points: pages.length, residual: 0 }
      : trophyGamma(pages, i, GAMMA_POOLED);
    const earnersTarget = Math.max(lastEarners * Math.pow(poolRatio, gamma), 1e-9);
    let center = clampRate((100 * earnersTarget) / poolTarget);

    // A trophy at the ceiling stays there; below it, no rate moves by more than
    // a factor of eight on one horizon.
    if (saturated) center = RATE_CEIL;
    else if (center > lastRate * 8) center = clampRate(lastRate * 8);
    else if (center < lastRate / 8) center = clampRate(lastRate / 8);

    // The spread: how far this trophy's own gamma could be wrong, how much the
    // rate genuinely drifts, and the page's refresh lagging the true state. With
    // no transitions of its own the field's own spread stands in.
    const gammaSd = points >= 2 ? Math.max(residual, GAMMA_SD_POOLED * 0.5) : GAMMA_SD_POOLED;
    const gammaError = gammaSd * Math.abs(span);
    let spread = Math.max(gammaError, walk) + REFRESH_ALLOWANCE;
    spread = Math.min(Math.max(spread, MIN_SPREAD), MAX_SPREAD);
    if (saturated) spread = 0.03;

    // Five quantiles, ascending, at the levels 0.05 0.25 0.5 0.75 0.95.
    const q: number[] = [];
    for (const z of Z) {
      q.push(Number(invLogit(logit(center) + z * spread).toFixed(4)));
    }
    for (let k = 0; k < 5; k++) q[k] = clampRate(q[k]);
    for (let k = 1; k < 5; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];

    rows.push({ id: trophy.id, q });
  }
  rows.sort((a, b) => a.id - b.id);
  return rows;
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  // The house puts only this case's file in /input, so read every *.in there in
  // name order and write one output for each.
  const caseIds = readdirSync(inDir)
    .filter((f) => f.endsWith('.in'))
    .map((f) => f.replace(/\.in$/, ''))
    .sort();

  for (const id of caseIds) {
    const c = JSON.parse(readFileSync(`${inDir}/${id}.in`, 'utf8')) as Case;
    // /output/<id>.out holds exactly {"trophies":[{id, q:[q05..q95}]}.
    writeFileSync(`${outDir}/${id}.out`, JSON.stringify({ trophies: forecast(c) }));
  }
}

main();
