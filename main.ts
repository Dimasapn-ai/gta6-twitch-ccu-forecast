// gta6-twitch-ccu-forecast-01 entry (Node 22, standard library only, offline).
//
// For every case file <id>.in in the input directory it writes <id>.out to the
// output directory: {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]} with
// exactly 23 rows, hours 2..24. The forecasting model lives in forecast.ts and
// is summarised in README.md: a launch-day shape learned from the case's own
// comparables — the weighted median log-ratio curve of past launches' release
// days, anchored on the case's hour-1 print, with a robust per-hour spread.
//
// An invalid case (missing, malformed or oversized output, a crash, a timeout)
// scores as a flat forecast at hour 1 and ranks below every valid entry, so
// this wrapper is defensive above all: each file is handled in its own
// try/catch, and any failure degrades to a flat forecast at the best hour-1
// print it can find rather than no file at all. Output is deterministic: file
// order is sorted and the model has no randomness, so two runs of a case are
// byte-for-byte identical.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecastCase, type CaseLike, type HourForecast } from './forecast.ts';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Best-effort hour-1 print from a (possibly malformed) case object. */
function fallbackP1(c: unknown): number {
  try {
    const known = (c as CaseLike)?.known;
    if (Array.isArray(known)) {
      for (const k of known) {
        if (k && typeof k.viewers === 'number' && Number.isFinite(k.viewers) && k.viewers > 0) {
          return Math.max(1, k.viewers);
        }
      }
    }
  } catch {
    // Fall through to 1.
  }
  return 1;
}

/** The flat emergency forecast: every quantile at p1, valid by construction. */
function flatForecast(p1: number): HourForecast[] {
  const v = Math.min(1e9, Math.max(0.01, Math.round(p1 * 100) / 100));
  return Array.from({ length: 23 }, (_, i) => ({ hour: i + 2, q: [v, v, v, v, v] }));
}

/** One case file in, one forecast file out; never throws. */
function runCase(file: string): void {
  const id = file.slice(0, -'.in'.length);
  let rows: HourForecast[];
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseLike;
    try {
      rows = forecastCase(c);
    } catch {
      rows = flatForecast(fallbackP1(c));
    }
  } catch {
    rows = flatForecast(1);
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: rows })}\n`);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
let inputs: string[] = [];
try {
  inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
} catch {
  inputs = [];
}
for (const file of inputs) runCase(file);
