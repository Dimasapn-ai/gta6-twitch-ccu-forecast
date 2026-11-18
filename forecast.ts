// forecast.ts — the forecasting core for gta6-twitch-ccu-forecast-01.
//
// Method (see README.md): a launch-day shape model learned from the case's own
// `comparables`. Every past launch in the case file contributes the log-ratio
// curve of its release day, log(viewers_h / viewers_1) for h = 2..24 in the UTC
// frame of its `day_start`. The forecast for an hour is the case's hour-1 print
// times the exponential of a location (weighted median of the pool's log-ratios
// at that hour) plus a normal-approx quantile offset using a robust per-hour
// scale (weighted MAD), calibrated by leave-one-out backtesting on the pool.
//
// Launches are kernel-weighted by two features observable for the case at the
// checkpoint, so launches whose unlock pattern resembles the case's count
// more: featA = log(hour1 / pre-day peak) (was there already a big audience
// before the UTC day began — a rolling regional unlock — or did the audience
// arrive only with a single global unlock?) and featG = log(hour1 / previous
// hour) (the last step into hour 1: still ramping, or already dipping?).
//
// Everything is defensive: any missing or malformed piece degrades toward a
// flat forecast at hour 1's print instead of failing, because an invalid case
// scores worse than any honest forecast.

export interface HourPoint {
  from?: string;
  at?: string;
  viewers?: number;
}

export interface Comparable {
  name?: string;
  day_start?: string;
  unlock?: string;
  hourly?: HourPoint[];
}

export interface CaseLike {
  day_start?: string;
  notes?: string;
  known?: Array<{ hour?: number; viewers?: number }>;
  forecast?: Array<{ hour?: number }>;
  history?: HourPoint[];
  history_hourly?: HourPoint[];
  comparables?: Comparable[];
  levels?: number[];
}

export interface ForecastOptions {
  /** Multiply the robust per-hour scale before applying normal quantiles. */
  spreadMult: number;
  /** Floor for the per-hour log scale, so no hour is ever over-confident. */
  spreadMin: number;
  /** Kernel weight floor: every valid launch keeps at least this weight. */
  weightFloor: number;
  /** Kernel bandwidth for featA (log units). */
  bwA: number;
  /** Kernel bandwidth for featG (log units). */
  bwG: number;
  /** Kernel weighting on (true) or the plain pooled curve (false). */
  useWeights: boolean;
  /** Weight pool launches by whether their unlock regime matches the case's. */
  useRegime: boolean;
  /** Share of the weighted mean in the location (0 = pure weighted median). */
  locMeanShare: number;
}

export const DEFAULT_OPTIONS: ForecastOptions = {
  spreadMult: 1.15,
  spreadMin: 0.15,
  weightFloor: 0.15,
  bwA: 0.5,
  bwG: 0.5,
  useWeights: true,
  useRegime: true,
  locMeanShare: 0.35,
};

export const LEVELS: number[] = [0.05, 0.25, 0.5, 0.75, 0.95];

const HOUR_MS = 3600000;

/** Standard normal quantile (Acklam's approximation). */
export function normQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Parse an ISO timestamp to epoch ms; NaN when unusable. */
function ts(s: string | undefined): number {
  if (typeof s !== 'string') return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/** A viewers figure that is a finite positive number, else null. */
function pos(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export type Regime = 'rolling' | 'global' | 'unknown';

/** Classify an unlock description (a comparable's `unlock`, a case's `notes`). */
export function classifyRegime(text: string | undefined): Regime {
  if (typeof text !== 'string') return 'unknown';
  const s = text.toLowerCase();
  const rolling = /midnight local|rolling/.test(s);
  const global = /simultaneous|single global|one global|global unlock|single time|same moment/.test(s);
  if (rolling && !global) return 'rolling';
  if (global && !rolling) return 'global';
  if (rolling && global) return 'rolling'; // mixed platform launches still roll region by region on console
  return 'unknown';
}

export interface LaunchCurve {
  /** Log-ratio to hour 1 for hours 2..24 (index 0 = hour 2); null where unknown. */
  ratios: Array<number | null>;
  featA: number | null;
  featG: number | null;
  regime: Regime;
}

/** Build the release-day log-ratio curve of one comparable, or null when it has no usable release day. */
export function launchCurve(comp: Comparable): LaunchCurve | null {
  const t0 = ts(comp.day_start);
  if (!Number.isFinite(t0) || !Array.isArray(comp.hourly)) return null;
  const byHour = new Map<number, number>();
  for (const p of comp.hourly) {
    const t = ts(p.from ?? p.at);
    const v = pos(p.viewers);
    if (!Number.isFinite(t) || v === null) continue;
    const off = Math.round((t - t0) / HOUR_MS);
    if (Math.abs(t - (t0 + off * HOUR_MS)) <= HOUR_MS / 2) byHour.set(off, v);
  }
  const v1 = byHour.get(0);
  if (v1 === undefined) return null;
  const ratios: Array<number | null> = [];
  let known = 0;
  for (let h = 2; h <= 24; h++) {
    const v = byHour.get(h - 1);
    if (v !== undefined) {
      ratios.push(Math.log(v / v1));
      known++;
    } else {
      ratios.push(null);
    }
  }
  if (known < 12) return null;
  let prePeak: number | null = null;
  for (let off = -24; off < 0; off++) {
    const v = byHour.get(off);
    if (v !== undefined && (prePeak === null || v > prePeak)) prePeak = v;
  }
  const prev = byHour.get(-1);
  return {
    ratios,
    featA: prePeak !== null ? Math.log(v1 / prePeak) : null,
    featG: prev !== undefined ? Math.log(v1 / prev) : null,
    regime: classifyRegime(comp.unlock),
  };
}

export interface CaseFeatures {
  p1: number;
  featA: number | null;
  featG: number | null;
}

/** The case's own hour-1 print and the two shape features, from its history. */
export function caseFeatures(c: CaseLike): CaseFeatures {
  let p1: number | null = null;
  if (Array.isArray(c.known)) {
    for (const k of c.known) {
      const v = pos(k.viewers);
      if (k.hour === 1 && v !== null) p1 = v;
    }
    if (p1 === null) {
      for (const k of c.known) {
        const v = pos(k.viewers);
        if (v !== null) p1 = v;
      }
    }
  }
  const t0 = ts(c.day_start);
  // Whole-hour history before the checkpoint: prefer history_hourly, else
  // bucket the raw history points by hour and average them.
  const hourMean = new Map<number, number>();
  if (Number.isFinite(t0)) {
    if (Array.isArray(c.history_hourly) && c.history_hourly.length > 0) {
      for (const p of c.history_hourly) {
        const v = pos(p.viewers);
        const t = ts(p.from ?? p.at);
        if (v === null || !Number.isFinite(t)) continue;
        const off = Math.floor((t - t0) / HOUR_MS);
        hourMean.set(off, v);
      }
    } else if (Array.isArray(c.history)) {
      const sums = new Map<number, { s: number; n: number }>();
      for (const p of c.history) {
        const v = pos(p.viewers);
        const t = ts(p.at ?? p.from);
        if (v === null || !Number.isFinite(t)) continue;
        const off = Math.floor((t - t0) / HOUR_MS);
        const e = sums.get(off) ?? { s: 0, n: 0 };
        e.s += v;
        e.n += 1;
        sums.set(off, e);
      }
      for (const [off, e] of sums) hourMean.set(off, e.s / e.n);
    }
  }
  if (p1 === null) {
    const h1 = hourMean.get(0);
    if (h1 !== undefined) p1 = h1;
  }
  if (p1 === null && Array.isArray(c.history) && c.history.length > 0) {
    for (let i = c.history.length - 1; i >= 0 && p1 === null; i--) p1 = pos(c.history[i].viewers);
  }
  if (p1 === null || p1 < 1) p1 = 1;
  let prePeak: number | null = null;
  for (let off = -24; off < 0; off++) {
    const v = hourMean.get(off);
    if (v !== undefined && (prePeak === null || v > prePeak)) prePeak = v;
  }
  const prev = hourMean.get(-1);
  return {
    p1,
    featA: prePeak !== null ? Math.log(p1 / prePeak) : null,
    featG: prev !== undefined ? Math.log(p1 / prev) : null,
  };
}

/** Weighted median of (value, weight) pairs; NaN on empty input. */
function weightedMedian(pairs: Array<{ v: number; w: number }>): number {
  if (pairs.length === 0) return NaN;
  const sorted = [...pairs].sort((a, b) => a.v - b.v);
  let total = 0;
  for (const p of sorted) total += p.w;
  let acc = 0;
  for (const p of sorted) {
    acc += p.w;
    if (acc >= total / 2) return p.v;
  }
  return sorted[sorted.length - 1].v;
}

export interface HourForecast {
  hour: number;
  q: number[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Forecast one case: 23 rows for hours 2..24 at the case's levels. Never throws. */
export function forecastCase(c: CaseLike, opts: ForecastOptions = DEFAULT_OPTIONS): HourForecast[] {
  const levels = Array.isArray(c.levels) && c.levels.length > 0 ? c.levels : LEVELS;
  const z = levels.map((t) => normQuantile(Math.min(0.999, Math.max(0.001, t))));
  const feat = caseFeatures(c);
  const p1 = feat.p1;

  const curves: LaunchCurve[] = [];
  if (Array.isArray(c.comparables)) {
    for (const comp of c.comparables) {
      try {
        const lc = launchCurve(comp);
        if (lc !== null) curves.push(lc);
      } catch {
        // A malformed comparable costs its curve, never the run.
      }
    }
  }
  const caseRegime = classifyRegime(c.notes);
  const weightOf = (lc: LaunchCurve): number => {
    let w = 1;
    if (opts.useWeights) {
      let d2 = 0;
      let used = false;
      if (feat.featA !== null && lc.featA !== null) {
        const d = (feat.featA - lc.featA) / opts.bwA;
        d2 += d * d;
        used = true;
      }
      if (feat.featG !== null && lc.featG !== null) {
        const d = (feat.featG - lc.featG) / opts.bwG;
        d2 += d * d;
        used = true;
      }
      if (used) w = opts.weightFloor + (1 - opts.weightFloor) * Math.exp(-0.5 * d2);
    }
    if (opts.useRegime && caseRegime !== 'unknown') {
      if (lc.regime === caseRegime) w *= 1.0;
      else if (lc.regime === 'unknown') w *= 0.6;
      else w *= 0.25;
    }
    return w;
  };
  const weights = curves.map(weightOf);

  // Per-hour location and robust scale from the pool's log-ratios.
  const med: number[] = [];
  const scale: number[] = [];
  for (let i = 0; i < 23; i++) {
    const pairs: Array<{ v: number; w: number }> = [];
    for (let j = 0; j < curves.length; j++) {
      const r = curves[j].ratios[i];
      if (r !== null && Number.isFinite(r)) pairs.push({ v: r, w: weights[j] });
    }
    if (pairs.length === 0) {
      med.push(NaN);
      scale.push(NaN);
      continue;
    }
    const mMed = weightedMedian(pairs);
    let m = mMed;
    if (opts.locMeanShare > 0) {
      let sw = 0;
      let sv = 0;
      for (const p of pairs) {
        sw += p.w;
        sv += p.w * p.v;
      }
      const mean = sw > 0 ? sv / sw : mMed;
      m = (1 - opts.locMeanShare) * mMed + opts.locMeanShare * mean;
    }
    const devs = pairs.map((p) => ({ v: Math.abs(p.v - m), w: p.w }));
    const mad = weightedMedian(devs);
    med.push(m);
    scale.push(Math.max(opts.spreadMin, 1.4826 * mad));
  }
  // Fill any hour the pool could not speak for from its neighbours, then
  // smooth the scale over a 3-hour window so one thin hour cannot spike it.
  for (let i = 0; i < 23; i++) {
    if (!Number.isFinite(med[i])) {
      let lo = i - 1;
      while (lo >= 0 && !Number.isFinite(med[lo])) lo--;
      let hi = i + 1;
      while (hi < 23 && !Number.isFinite(med[hi])) hi++;
      med[i] = lo >= 0 ? med[lo] : hi < 23 ? med[hi] : 0;
      scale[i] = lo >= 0 ? scale[lo] : hi < 23 ? scale[hi] : opts.spreadMin;
    }
  }
  const smooth = [...scale];
  for (let i = 0; i < 23; i++) {
    const a = scale[Math.max(0, i - 1)];
    const b = scale[i];
    const d = scale[Math.min(22, i + 1)];
    smooth[i] = Math.sqrt((a * a + b * b + d * d) / 3);
  }

  const hoursWanted: number[] = [];
  if (Array.isArray(c.forecast) && c.forecast.length > 0) {
    for (const f of c.forecast) {
      if (typeof f.hour === 'number' && f.hour >= 2 && f.hour <= 24) hoursWanted.push(f.hour);
    }
  }
  const hours = hoursWanted.length === 23 ? hoursWanted : Array.from({ length: 23 }, (_, i) => i + 2);

  return hours.map((h) => {
    const i = h - 2;
    const m = Number.isFinite(med[i]) ? med[i] : 0;
    const s = (Number.isFinite(smooth[i]) ? smooth[i] : opts.spreadMin) * opts.spreadMult;
    const q = z.map((zz) => {
      let v = p1 * Math.exp(m + zz * s);
      if (!Number.isFinite(v) || v <= 0) v = p1;
      return Math.min(1e9, Math.max(0.01, v));
    });
    q.sort((a, b) => a - b);
    const out: number[] = [];
    let prevQ = 0;
    for (const v of q) {
      const r = Math.max(prevQ, round2(v));
      out.push(r);
      prevQ = r;
    }
    return { hour: h, q: out };
  });
}
