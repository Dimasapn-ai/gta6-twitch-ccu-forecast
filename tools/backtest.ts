// tools/backtest.ts — dev-only leave-one-out backtest. Not imported by main.ts.
//
// Each comparable in a practice case becomes a pseudo-case: its release-day
// hour 1 is the known print, its hours 2..24 are the truth, and its curve pool
// is every other comparable in the file (leave-one-out). The pseudo-case's
// history is the comparable's own hourly points before its checkpoint, shaped
// like a real case's history_hourly. Scores are mean pinball loss on the log
// scale, exactly as the contest defines it.
//
//   node tools/backtest.ts            — default model vs the two baselines
//   node tools/backtest.ts grid       — also sweep the model's knobs

import { readFileSync } from 'node:fs';
import { forecastCase, normQuantile, classifyRegime, DEFAULT_OPTIONS, type CaseLike, type ForecastOptions } from '../forecast.ts';

const KIT_INPUT = '/home/hatch/workspace/makefun/twitch-kit/gta6-twitch-ccu-forecast-01-kit/input';
const HOUR_MS = 3600000;
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = LEVELS.map((t) => normQuantile(t));

interface RawComp {
  name: string;
  day_start: string;
  unlock?: string;
  hourly: Array<{ from: string; viewers: number; channels?: number }>;
}

/** Release-day viewers by hour (1..24) of a comparable, or null when incomplete. */
function releaseDay(comp: RawComp): number[] | null {
  const t0 = Date.parse(comp.day_start);
  const byHour = new Map<number, number>();
  for (const p of comp.hourly) byHour.set(Date.parse(p.from), p.viewers);
  const day: number[] = [];
  for (let h = 0; h < 24; h++) {
    const v = byHour.get(t0 + h * HOUR_MS);
    if (typeof v !== 'number' || !(v > 0)) return null;
    day.push(v);
  }
  return day;
}

function pinball(qs: number[], truth: number[], p1: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 23; i++) {
    const y = Math.max(1, truth[i]);
    for (let j = 0; j < 5; j++) {
      const d = Math.log(y) - Math.log(qs[i * 5 + j] ?? p1);
      const tau = LEVELS[j];
      sum += 2 * Math.max(tau * d, (tau - 1) * d);
      n++;
    }
  }
  return sum / n;
}

const flatA = (p1: number): number[] => Array.from({ length: 23 * 5 }, () => p1);
const flatB = (p1: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < 23; i++) for (const z of Z) out.push(p1 * Math.exp(z * 0.35));
  return out;
};

function main(): void {
  const file = JSON.parse(readFileSync(`${KIT_INPUT}/p00.in`, 'utf8')) as CaseLike & { comparables: RawComp[] };
  const comps = file.comparables;

  interface Pseudo {
    name: string;
    caseObj: CaseLike;
    truth: number[];
    p1: number;
  }
  const pseudos: Pseudo[] = [];
  for (const comp of comps) {
    const day = releaseDay(comp);
    if (day === null) continue;
    const t0 = Date.parse(comp.day_start);
    const hist = comp.hourly
      .filter((p) => Date.parse(p.from) < t0 + HOUR_MS)
      .map((p) => ({ from: p.from, viewers: p.viewers, channels: p.channels, reads: 1 }));
    pseudos.push({
      name: comp.name,
      p1: day[0],
      truth: day.slice(1),
      caseObj: {
        day_start: comp.day_start,
        // In production the case's regime comes from its `notes`; a pseudo-case
        // takes it from its own comparable entry's `unlock` text instead.
        notes: comp.unlock,
        known: [{ hour: 1, viewers: day[0] }],
        forecast: Array.from({ length: 23 }, (_, i) => ({ hour: i + 2 })),
        history_hourly: hist,
        history: hist.map((p) => ({ at: p.from, viewers: p.viewers, channels: p.channels })),
        comparables: comps.filter((o) => o !== comp) as CaseLike['comparables'],
        levels: LEVELS,
      },
    });
  }
  console.log(`pseudo-cases: ${pseudos.length}`);

  const evaluate = (name: string, fc: (pc: Pseudo) => number[]): void => {
    const losses = pseudos.map((pc) => pinball(fc(pc), pc.truth, pc.p1));
    const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
    const sorted = [...losses].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];
    console.log(`${name.padEnd(38)} mean ${mean.toFixed(4)}  median ${med.toFixed(4)}  worst ${worst.toFixed(4)}`);
  };

  evaluate('baseline (a) flat at hour 1', (pc) => flatA(pc.p1));
  evaluate('baseline (b) flat median, sigma 0.35', (pc) => flatB(pc.p1));
  const model = (opts: ForecastOptions) => (pc: Pseudo) => forecastCase(pc.caseObj, opts).flatMap((r) => r.q);
  evaluate('model (defaults)', model(DEFAULT_OPTIONS));
  evaluate('model (no weights)', model({ ...DEFAULT_OPTIONS, useWeights: false }));
  evaluate('model (no regime)', model({ ...DEFAULT_OPTIONS, useRegime: false }));

  // The contest's real cases (the four practice launches and the final) are
  // all rolling-midnight console launches, so report that subset separately.
  const rolling = pseudos.filter((pc) => classifyRegime(pc.caseObj.notes) === 'rolling');
  console.log(`\nrolling-regime pseudo-cases: ${rolling.length}`);
  const evalSubset = (name: string, fc: (pc: Pseudo) => number[]): void => {
    const losses = rolling.map((pc) => pinball(fc(pc), pc.truth, pc.p1));
    const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
    console.log(`${name.padEnd(38)} mean ${mean.toFixed(4)}`);
  };
  evalSubset('  subset baseline (a)', (pc) => flatA(pc.p1));
  evalSubset('  subset baseline (b)', (pc) => flatB(pc.p1));
  evalSubset('  subset model (defaults)', model(DEFAULT_OPTIONS));
  evalSubset('  subset model (no regime)', model({ ...DEFAULT_OPTIONS, useRegime: false }));

  if (process.argv.includes('grid')) {
    const combos: Array<[string, ForecastOptions]> = [
      ['combo share.35', { ...DEFAULT_OPTIONS, locMeanShare: 0.35 }],
      ['combo share.35 bw.5', { ...DEFAULT_OPTIONS, locMeanShare: 0.35, bwA: 0.5, bwG: 0.5 }],
      ['combo share.35 bw.5 mult1.25', { ...DEFAULT_OPTIONS, locMeanShare: 0.35, bwA: 0.5, bwG: 0.5, spreadMult: 1.25 }],
      ['combo share.5 bw.5 mult1.25', { ...DEFAULT_OPTIONS, locMeanShare: 0.5, bwA: 0.5, bwG: 0.5, spreadMult: 1.25 }],
      ['combo share.35 mult1.4', { ...DEFAULT_OPTIONS, locMeanShare: 0.35, spreadMult: 1.4 }],
      ['combo bw.5 mult1.25', { ...DEFAULT_OPTIONS, bwA: 0.5, bwG: 0.5, spreadMult: 1.25 }],
    ];
    for (const [name, opts] of combos) {
      evaluate(name, model(opts));
      const losses = rolling.map((pc) => pinball(model(opts)(pc), pc.truth, pc.p1));
      const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
      console.log(`${`  ^ rolling subset`.padEnd(38)} mean ${mean.toFixed(4)}`);
    }
  }

  if (process.argv.includes('fullgrid')) {
    for (const mult of [0.9, 1.0, 1.1, 1.25, 1.4]) {
      evaluate(`grid mult=${mult}`, model({ ...DEFAULT_OPTIONS, spreadMult: mult }));
    }
    for (const share of [0.2, 0.35, 0.5]) {
      evaluate(`grid locMeanShare=${share}`, model({ ...DEFAULT_OPTIONS, locMeanShare: share }));
    }
    for (const bw of [0.5, 1.2, 2.0]) {
      evaluate(`grid bwA=bwG=${bw}`, model({ ...DEFAULT_OPTIONS, bwA: bw, bwG: bw }));
    }
    for (const floor of [0.05, 0.3]) {
      evaluate(`grid weightFloor=${floor}`, model({ ...DEFAULT_OPTIONS, weightFloor: floor }));
    }
    for (const smin of [0.08, 0.25]) {
      evaluate(`grid spreadMin=${smin}`, model({ ...DEFAULT_OPTIONS, spreadMin: smin }));
    }
    // Per-case detail for the default model, to see where it hurts.
    console.log('\nper-case (default model vs flat-a):');
    for (const pc of pseudos) {
      const lm = pinball(model(DEFAULT_OPTIONS)(pc), pc.truth, pc.p1);
      const la = pinball(flatA(pc.p1), pc.truth, pc.p1);
      console.log(`  ${pc.name.slice(0, 36).padEnd(36)} model ${lm.toFixed(3)}  flat ${la.toFixed(3)}`);
    }
  }
}

main();
