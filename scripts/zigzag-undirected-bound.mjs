#!/usr/bin/env node
// Undirected expansion bound for the ZigZag in-layer expander (full Chung graph:
// 8 permutation slots per node, each used through the permutation and its
// inverse) and the layer count and challenge budget that it supports. With the
// defaults below this is the bound B3 of the report "Parallel decoding for
// Filecoin's PoRep: SDR v2 and ZigZag" (Section 3.4, Appendix B).
// Method, margin and results: docs/runtime/zigzag-undirected-bound.md.

export const DEGREE = 8;
// The layer program reads the expansion function E at x = i / GRID.
export const GRID = 10000;
// E is computed at x = i / CURVE_GRID and used between these points as its
// value at the point below.
export const CURVE_GRID = 1000;
export const EXPANSION_FROM = 0.001;
// A chain of layers ends when a layer reaches this fraction of forward dependencies.
export const CHAIN_END = 0.8;
export const SPACEGAP = 0.2;
// Safety margin on the union-bound exponent: 1e-4 bits per node. MARGIN is the
// same margin in nats, the unit of exponent().
export const MARGIN_BITS = 1e-4;
export const MARGIN = MARGIN_BITS * Math.LN2;
export const LAMBDA = 10;
export const MAX_CHALLENGES_PER_PARTITION = 18;

function xlnx(x) {
  return x > 0 ? x * Math.log(x) : 0;
}

// Certified lower bound on KL* = min KL(x || rho x rho) over couplings x with
// both marginals rho = (S, C, O) and no mass on the forbidden slot pairs S->C
// and C->S. For every positive m, KL* >= 2 sum rho_a ln(m_a / rho_a) - ln Z(m)
// (Donsker-Varadhan), so an imprecise solve can only weaken the bound. m is the
// symmetric scaling m_S (m_S + m_O) = rho_S, m_C (m_C + m_O) = rho_C and
// m_O (m_S + m_C + m_O) = rho_O, found by bisection in m_O.
export function klLowerBound(rs, rc, ro) {
  let lo = 0;
  let hi = 1;
  for (let iteration = 0; iteration < 44; iteration++) {
    const o = 0.5 * (lo + hi);
    const a = 0.5 * (-o + Math.sqrt(o * o + 4 * rs));
    const c = 0.5 * (-o + Math.sqrt(o * o + 4 * rc));
    if (o * (a + c + o) < ro) lo = o;
    else hi = o;
  }
  const o = 0.5 * (lo + hi);
  const a = 0.5 * (-o + Math.sqrt(o * o + 4 * rs));
  const c = 0.5 * (-o + Math.sqrt(o * o + 4 * rc));
  const z = a * (a + o) + c * (c + o) + o * (a + c + o);
  let value = 0;
  for (const [m, r] of [[a, rs], [c, rc], [o, ro]]) {
    if (r > 0) value += 2 * r * Math.log(m / r);
  }
  return value - Math.log(z);
}

// Union-bound exponent per node, in nats, for a set S of alpha n nodes whose
// closed neighbourhood lies in a set T of beta n nodes: the number of (S, T)
// pairs is at most exp(n H) and one random permutation of the d n slots avoids
// every S-C and C-S slot pair with probability at most poly(n) exp(-d n KL*).
export function exponent(alpha, beta, degree = DEGREE) {
  const rs = alpha;
  const rc = 1 - beta;
  const ro = beta - alpha;
  const entropy = -(xlnx(rs) + xlnx(rc) + xlnx(ro));
  return entropy - degree * klLowerBound(rs, rc, ro);
}

// Largest beta found with exponent(alpha, beta) <= -margin. Bisection keeps a
// checked point, so the result is certified even where the exponent is not monotone.
export function largestBeta(alpha, margin = MARGIN, degree = DEGREE) {
  let lo = alpha * (1 + 1e-9) + 1e-12;
  if (exponent(alpha, lo, degree) > -margin) return alpha;
  let hi = 1 - 1e-9;
  for (let iteration = 0; iteration < 46; iteration++) {
    const mid = 0.5 * (lo + hi);
    if (exponent(alpha, mid, degree) <= -margin) lo = mid;
    else hi = mid;
  }
  return lo;
}

function monotone(table) {
  let peak = 0;
  return table.map((value) => (peak = Math.max(peak, value)));
}

// E(x) on the grid: the certified expansion at the curve point below x, for
// curve points from EXPANSION_FROM to CHAIN_END, and no expansion elsewhere.
// The value at the point below is a lower bound, and E is non-decreasing,
// because a larger set contains a smaller one with the same neighbours.
// curveGrid = GRID computes the curve at every x of the layer program instead.
export function expansionTable(margin = MARGIN, degree = DEGREE, curveGrid = CURVE_GRID) {
  const table = new Float64Array(GRID + 1);
  let point = -1;
  let beta = 0;
  for (let index = 0; index <= GRID; index++) {
    const below = Math.floor((index * curveGrid) / GRID);
    if (below !== point) {
      point = below;
      const alpha = point / curveGrid;
      beta = alpha >= EXPANSION_FROM && alpha <= CHAIN_END + 1e-12 ? largestBeta(alpha, margin, degree) : 0;
    }
    table[index] = Math.max(index / GRID, beta);
  }
  return monotone(table);
}

function binaryEntropy(p) {
  return p <= 0 || p >= 1 ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
}

// The one-directional Chung bound B2 of the report (formula (2.1) of Fisch
// 2019): largest beta with Hb(a) + Hb(b) + d (b Hb(a / b) - Hb(a)) < -margin,
// in bits per node.
export function chungBeta(alpha, degree = DEGREE, marginBits = MARGIN_BITS) {
  const f = (beta) => binaryEntropy(alpha) + binaryEntropy(beta)
    + degree * (beta * binaryEntropy(alpha / beta) - binaryEntropy(alpha)) + marginBits;
  let lo = alpha;
  let hi = 1;
  if (f(lo) >= 0) return alpha;
  for (let iteration = 0; iteration < 80; iteration++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function chungTable(degree = DEGREE, marginBits = MARGIN_BITS) {
  const table = new Float64Array(GRID + 1);
  for (let index = 0; index <= GRID; index++) {
    const x = index / GRID;
    table[index] = x < EXPANSION_FROM || x > CHAIN_END ? x : Math.max(x, chungBeta(x, degree, marginBits));
  }
  return monotone(table);
}

function bisectLeft(table, target) {
  let lo = 0;
  let hi = table.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (table[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Layer dynamic program of the report (Lemma 3.4 and Appendix A.1). The
// adversary splits (1 - SPACEGAP) n black pebbles between the steps of a chain;
// a step from a fraction a of forward dependencies reaches at least
// max(x, E(x) - sigma), sigma = r + 2 delta, x = a - sigma. Returns the smallest
// number of steps s (2 s + 1 layers) after which every split on a grid of step h
// reaches CHAIN_END, or null if more than maxSteps are needed. Conservative
// rounding favours the adversary at every grid value. So does an exact tie
// between the start of a chain and the fraction the adversary needs: grid
// values make such ties common, and float noise must not decide them.
export function layerSteps(table, delta, h, { conservative = true, maxSteps = 60 } = {}) {
  const tie = conservative ? 1e-12 : -1e-12;
  const inverse = (y) => {
    let index = bisectLeft(table, y) - 1;
    if (conservative) index += 1;
    return Math.max(0, Math.min(GRID, index)) / GRID;
  };
  const size = Math.round((1 - SPACEGAP) / h);
  let previous = new Float64Array(size + 1).fill(CHAIN_END);
  for (let step = 1; step <= maxSteps; step++) {
    const current = new Float64Array(size + 1);
    for (let budget = 0; budget <= size; budget++) {
      let best = 0;
      for (let spent = 0; spent <= budget; spent++) {
        const sigma = spent * h + 2 * delta;
        let rest = budget - spent;
        // The real spend may be up to h smaller than its grid value.
        if (conservative && spent > 0) rest += 1;
        const reached = previous[Math.min(rest, size)];
        const value = sigma + Math.min(reached, inverse(reached + sigma));
        if (value > best) best = value;
      }
      // A chain that starts at CHAIN_END has already ended.
      current[budget] = Math.min(CHAIN_END, best);
    }
    let reachesEnd = true;
    for (let budget = 0; budget <= size; budget++) {
      const needed = conservative ? current[Math.min(budget + 1, size)] : current[budget];
      if (budget * h + SPACEGAP / 2 - delta < needed + tie) {
        reachesEnd = false;
        break;
      }
    }
    if (reachesEnd) return step;
    if (current.every((value, index) => Math.abs(value - previous[index]) < 1e-12)) return null;
    previous = current;
  }
  return null;
}

export function layersForSteps(steps) {
  return steps === null ? null : 2 * steps + 1;
}

// Offline challenges per layer for 2^-lambda soundness at a fraction delta of wrong labels.
export function challengesPerLayer(delta, lambda = LAMBDA) {
  return Math.ceil(lambda / -Math.log2(1 - delta));
}

// Largest fraction of wrong labels that a number of challenges per layer covers.
export function coveredDelta(challenges, lambda = LAMBDA) {
  return 1 - 2 ** (-lambda / challenges);
}

export function partitionPlan(minimumChallenges, partitions) {
  const perPartition = Math.ceil(minimumChallenges / partitions);
  return { partitions, perPartition, perLayer: partitions * perPartition };
}

// Polynomial factors of the union bound for one pair of sizes, in nats: the
// expected number of pairs (S, T) with N[S] in T is at most exp(n * exponent)
// times Stirling factors of at most 3 ln(2 pi d n) + 1/2 and at most
// (d n + 1)^2 slot-flow matrices.
export function unionBoundAllowance(nodes, degree = DEGREE) {
  const slots = degree * nodes;
  return 3 * Math.log(2 * Math.PI * slots) + 0.5 + 2 * Math.log(slots + 1);
}

// Smallest margin, in nats per node, for which the union bound fails with
// probability at most 2^-bits on n nodes: the allowance above for every curve
// point and every layer.
export function requiredMargin(nodes, { degree = DEGREE, layers = 13, bits = 128, curveGrid = CURVE_GRID } = {}) {
  const sizes = Math.round((CHAIN_END - EXPANSION_FROM) * curveGrid) + 1;
  const nats = unionBoundAllowance(nodes, degree) + Math.log(sizes) + Math.log(layers) + bits * Math.LN2;
  return nats / nodes;
}

function parseNumbers(argument, value) {
  const numbers = value.split(",").map(Number);
  if (!value || numbers.some((number) => !Number.isFinite(number) || number < 0 || number >= 1)) {
    throw new Error(`${argument} expects comma-separated numbers in [0, 1)`);
  }
  return numbers;
}

function main(argv) {
  let marginBits = MARGIN_BITS;
  let curveGrid = CURVE_GRID;
  let deltas = [0.002, 0.005, 0.01, coveredDelta(540), 0.013, 0.0133, 0.0134];
  let grids = [0.002, 0.001, 0.0005];
  for (const argument of argv) {
    const [name, value = ""] = argument.split("=");
    if (name === "--margin-bits") [marginBits] = parseNumbers(name, value);
    else if (name === "--curve-step") {
      const [step] = parseNumbers(name, value);
      curveGrid = Math.round(1 / step);
      if (!(step > 0) || !Number.isInteger(GRID / curveGrid)) throw new Error(`--curve-step expects a multiple of ${1 / GRID} that divides 1`);
    } else if (name === "--deltas") deltas = parseNumbers(name, value);
    else if (name === "--grids") grids = parseNumbers(name, value).filter((h) => h > 0);
    else throw new Error(`unknown argument: ${argument}; expected --margin-bits=, --curve-step=, --deltas= or --grids=`);
  }
  const margin = marginBits * Math.LN2;
  const bare = expansionTable(0, DEGREE, curveGrid);
  const table = expansionTable(margin, DEGREE, curveGrid);
  const probes = [0.001, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8];
  const print = (line = "") => process.stdout.write(`${line}\n`);
  print(`ZigZag undirected expansion bound: d = ${DEGREE}, margin ${marginBits} bits per node, curve step ${1 / curveGrid}`);
  print();
  print(`alpha              ${probes.map((alpha) => alpha.toFixed(3).padStart(8)).join("")}`);
  print(`beta, no margin    ${probes.map((alpha) => bare[Math.round(alpha * GRID)].toFixed(5).padStart(8)).join("")}`);
  print(`beta, margin       ${probes.map((alpha) => table[Math.round(alpha * GRID)].toFixed(5).padStart(8)).join("")}`);
  let shift = 0;
  for (let index = 0; index <= GRID; index++) shift = Math.max(shift, bare[index] - table[index]);
  const root = bare[Math.round(0.1 * GRID)];
  print();
  print(`exponent at the unmargined root (alpha 0.1, beta ${root.toFixed(6)}): ${exponent(0.1, root).toExponential(2)} nats (float noise)`);
  print(`largest shift of E by the margin: ${shift.toExponential(2)}`);
  for (const log2Nodes of [30, 24, 18]) {
    const needed = requiredMargin(2 ** log2Nodes, { curveGrid }) / Math.LN2;
    print(`n = 2^${log2Nodes}: margin needed for 2^-128 ${needed.toExponential(2)} bits per node, `
      + `n * margin = ${(2 ** log2Nodes * marginBits).toFixed(1)} bits${needed <= marginBits ? "" : " (below the 2^-128 target)"}`);
  }
  print();
  print("layers (2 * steps + 1), conservative / favourable rounding of the layer grid; '-' = more than 17");
  print(`delta      challenges ${grids.map((h) => `h = ${h}`.padEnd(12)).join("")}`);
  for (const delta of deltas) {
    const cells = grids.map((h) => {
      const [up, down] = [true, false].map((conservative) => layersForSteps(layerSteps(table, delta, h, { conservative, maxSteps: 8 })) ?? "-");
      return `${up} / ${down}`.padEnd(12);
    });
    print(`${delta.toFixed(5).padEnd(10)} ${String(challengesPerLayer(delta)).padEnd(10)} ${cells.join("")}`);
  }
  const plan = partitionPlan(challengesPerLayer(0.013), 36);
  print();
  print(`13 layers at delta 0.013: minimum ${challengesPerLayer(0.013)} challenges per layer; ${plan.partitions} partitions x `
    + `${plan.perPartition} = ${plan.perLayer} per layer (covers delta ${coveredDelta(plan.perLayer).toFixed(5)}), `
    + `${13 * plan.perLayer} challenge instances`);
}

if (process.argv[1]?.endsWith("zigzag-undirected-bound.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`zigzag-undirected-bound: ${error.message}\n`);
    process.exitCode = 2;
  }
}
