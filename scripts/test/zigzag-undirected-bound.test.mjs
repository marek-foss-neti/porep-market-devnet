import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CURVE_GRID,
  DEGREE,
  GRID,
  MARGIN,
  MARGIN_BITS,
  MAX_CHALLENGES_PER_PARTITION,
  challengesPerLayer,
  chungBeta,
  chungTable,
  coveredDelta,
  expansionTable,
  exponent,
  klLowerBound,
  largestBeta,
  layerSteps,
  layersForSteps,
  partitionPlan,
  requiredMargin,
  unionBoundAllowance,
} from "../zigzag-undirected-bound.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const table = expansionTable();
const layers =(expansion, delta, h, conservative = true, maxSteps = 8) =>
  layersForSteps(layerSteps(expansion, delta, h, { conservative, maxSteps }));

// KL(x || rho x rho) of the feasible coupling with x(S,S) = p and x(C,C) = q;
// the marginals fix every other cell and leave S->C and C->S empty.
function couplingKl(rs, rc, ro, p, q) {
  const cells = [
    [p, rs, rs], [rs - p, rs, ro], [rs - p, ro, rs],
    [q, rc, rc], [rc - q, rc, ro], [rc - q, ro, rc],
    [ro - (rs - p) - (rc - q), ro, ro],
  ];
  return cells.reduce((sum, [x, a, b]) => sum + (x > 0 ? x * Math.log(x / (a * b)) : 0), 0);
}

// KL is convex in (p, q), so nested ternary searches find the exact minimum.
function minimum(f, lo, hi) {
  for (let iteration = 0; iteration < 200; iteration++) {
    const left = lo + (hi - lo) / 3;
    const right = hi - (hi - lo) / 3;
    if (f(left) <= f(right)) hi = right;
    else lo = left;
  }
  return f((lo + hi) / 2);
}

function exactKl(rs, rc, ro) {
  return minimum(
    (p) => minimum((q) => couplingKl(rs, rc, ro, p, q), Math.max(0, rs - p + rc - ro), rc),
    Math.max(0, rs - ro),
    rs,
  );
}

test("KL lower bound is certified and tight against the exact minimum over couplings", () => {
  const points = [[0.001, 0.0099], [0.01, 0.093], [0.05, 0.358], [0.1, 0.5568], [0.2, 0.749], [0.4, 0.884],
    [0.6, 0.94], [0.8, 0.976], [0.03, 0.1], [0.3, 0.5], [0.5, 0.99]];
  for (const [alpha, beta] of points) {
    const [rs, rc, ro] = [alpha, 1 - beta, beta - alpha];
    const bound = klLowerBound(rs, rc, ro);
    const exact = exactKl(rs, rc, ro);
    assert.ok(bound <= exact + 1e-13, `bound ${bound} exceeds KL ${exact} at ${alpha}, ${beta}`);
    assert.ok(exact - bound < 1e-9, `bound ${bound} is loose against KL ${exact} at ${alpha}, ${beta}`);
  }
});

function lnFactorials(max) {
  const table = new Float64Array(max + 1);
  for (let value = 2; value <= max; value++) table[value] = table[value - 1] + Math.log(value);
  return table;
}

// Exact ln of the expected number of pairs (S, T), |S| = s, |T| = t, S in T,
// with N[S] in T under a uniformly random permutation of the d n slots: the
// number of pairs times the probability that no slot of S maps to a slot of
// C = V \ T and no slot of C maps to a slot of S. The probability is the sum
// over all slot-flow matrices of (prod_a N_a!)^2 / (N! prod_ab k_ab!).
function exactLnExpectedPairs(n, s, t, lnFactorial) {
  const c = n - t;
  const o = t - s;
  const [slotsS, slotsC, slotsO] = [DEGREE * s, DEGREE * c, DEGREE * o];
  const head = 2 * (lnFactorial[slotsS] + lnFactorial[slotsC] + lnFactorial[slotsO]) - lnFactorial[DEGREE * n];
  let peak = -Infinity;
  let sum = 0;
  for (let ss = Math.max(0, slotsS - slotsO); ss <= slotsS; ss++) {
    const so = slotsS - ss;
    const fromS = lnFactorial[ss] + 2 * lnFactorial[so];
    for (let cc = Math.max(0, slotsC - (slotsO - so)); cc <= slotsC; cc++) {
      const co = slotsC - cc;
      const value = head - fromS - lnFactorial[cc] - 2 * lnFactorial[co] - lnFactorial[slotsO - so - co];
      if (value > peak) {
        sum = sum * Math.exp(peak - value) + 1;
        peak = value;
      } else sum += Math.exp(value - peak);
    }
  }
  return lnFactorial[n] - lnFactorial[s] - lnFactorial[o] - lnFactorial[c] + peak + Math.log(sum);
}

test("the exponent bounds the exact expected number of violating pairs on small graphs", () => {
  // Every pair of sizes for 64 nodes and a sample for 256.
  for (const [n, sizes, step] of [[64, Array.from({ length: 51 }, (_, index) => index + 1), 1], [256, [3, 26, 102, 205], 8]]) {
    const lnFactorial = lnFactorials(DEGREE * n);
    let largest = -Infinity;
    for (const s of sizes) {
      for (let t = s; t < n; t += step) {
        const excess = exactLnExpectedPairs(n, s, t, lnFactorial) - n * exponent(s / n, t / n);
        assert.ok(excess <= unionBoundAllowance(n), `exact count exceeds the bound at n ${n}, s ${s}, t ${t}`);
        largest = Math.max(largest, excess);
      }
    }
    // The allowance is generous: the exact excess over exp(n * exponent) is about ln(8) / 2,
    // so an exponent that is too negative by a few 1e-3 per node already fails here.
    assert.ok(largest > 0 && largest < 2, `largest excess ${largest} at n ${n}`);
  }
});

test("the margin is 1e-4 bits per node and covers float noise and the union-bound factors", () => {
  assert.equal(MARGIN_BITS, 1e-4);
  assert.equal(MARGIN, MARGIN_BITS * Math.LN2);
  const root = largestBeta(0.1, 0);
  assert.ok(Math.abs(exponent(0.1, root)) < 1e-12);
  assert.ok(exponent(0.1, largestBeta(0.1)) <= -MARGIN);
  for (let point = 1; point <= 800; point += 47) {
    const alpha = point / CURVE_GRID;
    const shift = largestBeta(alpha, 0) - largestBeta(alpha);
    assert.ok(shift >= 0 && shift < 5e-5, `shift ${shift} at ${alpha}`);
  }
  // 2^-128 with the allowance: reached on 2^30 and 2^24 nodes, not on 2^18.
  assert.ok(requiredMargin(2 ** 30) < MARGIN / 100);
  assert.ok(requiredMargin(2 ** 24) < MARGIN);
  assert.ok(requiredMargin(2 ** 18) > MARGIN);
});

test("the default curve is B3 of the report and the one-directional bound is its B2", () => {
  // Appendix B of the report: x, B3(x), B2(x).
  for (const [x, b3, b2] of [[0.01, 0.0931, 0.0486], [0.1, 0.5568, 0.3362], [0.3, 0.8354, 0.6593], [0.5, 0.9173, 0.8188], [0.8, 0.9762, 0.9491]]) {
    assert.equal(largestBeta(x).toFixed(4), b3.toFixed(4));
    assert.equal(chungBeta(x).toFixed(4), b2.toFixed(4));
    assert.equal(table[Math.round(x * GRID)], largestBeta(x));
    assert.ok(chungBeta(x) < chungBeta(x, DEGREE, 0));
  }
  // Between curve points E is the value at the point below, not the value at x.
  assert.equal(table[1009], table[1000]);
  assert.ok(table[1009] < largestBeta(0.1009));
  assert.ok(table[1010] > table[1009]);
  assert.equal(expansionTable(MARGIN, DEGREE, GRID)[1009], largestBeta(0.1009));
});

test("the layer program reproduces the table of Section 3.4 and Proposition 3.5 of the report", () => {
  const chung = chungTable();
  // Table at h = 0.001: delta, layers with the grid rounded against the adversary and in its favour.
  for (const [delta, against, inFavour] of [[0, 11, 11], [0.002, 11, 11], [0.005, 11, 13], [0.01, 13, 13]]) {
    assert.equal(layers(table, delta, 0.001, false), against);
    assert.equal(layers(table, delta, 0.001, true), inFavour);
  }
  for (const [delta, against, inFavour] of [[0, 15, 15], [0.002, 15, 15], [0.005, 15, 17]]) {
    assert.equal(layers(chung, delta, 0.001, false), against);
    assert.equal(layers(chung, delta, 0.001, true), inFavour);
  }
  assert.equal(layerSteps(chung, 0.01, 0.001, { conservative: false }), null);
  // Proposition 3.5: 5 and 6 steps with B3, 7 and 8 with B2, with both roundings.
  for (const conservative of [true, false]) {
    assert.equal(layerSteps(table, 0.002, 0.001, { conservative }), 5);
    assert.equal(layerSteps(table, 0.013, 0.0005, { conservative }), 6);
    assert.equal(layerSteps(chung, 0.002, 0.001, { conservative }), 7);
    assert.equal(layerSteps(chung, 0.0092, 0.0005, { conservative }), 8);
  }
  // Section 3.5: the largest delta with a proved number of layers is between 0.0133 and 0.0134.
  assert.equal(layers(table, 0.0133, 0.0005), 13);
  assert.equal(layerSteps(table, 0.0134, 0.0005), null);
});

test("an exact tie counts for the adversary under conservative rounding and against it otherwise", () => {
  // At delta = 0.005 the chain that starts with budget 0.705 meets the needed fraction 0.80 exactly.
  assert.equal(layers(table, 0.005, 0.0005, true), 13);
  assert.equal(layers(table, 0.005, 0.0005, false), 11);
  assert.equal(layers(table, 0.0049, 0.0005, true), 11);
});

test("the chosen budget gives 13 layers on every layer grid, for other margins and for a finer curve", () => {
  const covered = coveredDelta(540);
  for (const h of [0.002, 0.001, 0.0005]) {
    assert.equal(layers(table, covered, h), 13);
    assert.equal(layers(table, 0.002, h), 11);
  }
  // delta = 0.013 itself needs a layer grid of 0.001 or finer.
  assert.equal(layerSteps(table, 0.013, 0.002), null);
  assert.equal(layers(table, 0.013, 0.001), 13);
  for (const other of [expansionTable(0), expansionTable(10 * MARGIN), expansionTable(1e-6, DEGREE, GRID)]) {
    assert.equal(layers(other, covered, 0.001), 13);
    assert.equal(layers(other, 0.002, 0.001), 11);
  }
});

test("challenge budget follows the report formula and the benchmark runner uses it", () => {
  assert.equal(challengesPerLayer(0.0092), 750);
  assert.equal(challengesPerLayer(0.002), 3463);
  assert.equal(challengesPerLayer(0.013), 530);
  assert.deepEqual(partitionPlan(530, 36), { partitions: 36, perPartition: 15, perLayer: 540 });
  assert.ok(coveredDelta(540) > 0.0127 && coveredDelta(540) < 0.0128);
  const script = readFileSync(join(root, "scripts/bench-zigzag.sh"), "utf8");
  const value = (name) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(script)?.[1]);
  const budget = { layers: value("layers"), partitions: value("partitions"), minimum: value("minimum_challenges"), perPartition: value("challenges") };
  assert.deepEqual(budget, { layers: 13, partitions: 36, minimum: 530, perPartition: 15 });
  assert.ok(budget.minimum >= challengesPerLayer(0.013));
  assert.equal(budget.perPartition, Math.ceil(budget.minimum / budget.partitions));
  assert.ok(budget.perPartition <= MAX_CHALLENGES_PER_PARTITION);
  for (const h of [0.002, 0.001, 0.0005]) {
    assert.equal(layers(table, coveredDelta(budget.partitions * budget.perPartition), h), budget.layers);
  }
});
