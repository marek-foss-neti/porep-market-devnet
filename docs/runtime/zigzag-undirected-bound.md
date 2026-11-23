# ZigZag undirected expansion bound

The ZigZag benchmark budget of 13 layers and at least 530 challenges per layer
(36 partitions × 15 = 540) follows from a union bound on the undirected
neighbourhoods of the full Chung expander. The report "Parallel decoding for
Filecoin's PoRep: SDR v2 and ZigZag" (draft of 16 November 2026) calls this
bound B₃ (Section 3.4 and Appendix B). Its Proposition 3.5 gives 13 layers for
δ ≤ 0.013 and 11 layers for δ ≤ 0.002. With the one-directional Chung bound
B₂, the same proposition needs 15 layers for δ ≤ 0.002 and 17 layers for
δ ≤ 0.0092, or 750 challenges per layer.

[zigzag-undirected-bound.mjs](../../scripts/zigzag-undirected-bound.mjs)
computes B₃ as the report defines it, the resulting layer counts and the
budget. The report's own scripts are in Python, in the folder `scripts/` of
<https://github.com/irenegia/parallel-decoding-porep>.

## Bound

Each node has 8 slots. A permutation π of the 8n slots joins nodes u and v
when π maps a slot of one to a slot of the other; the pinned implementation
uses every slot through both π and π⁻¹. The bound concerns N[S], the set S
together with its in-layer neighbours.

Take |S| = αn and |T| = βn with S ⊆ T, and let C be the complement of T.
N[S] ⊆ T forbids the slot pairs S→C and C→S. The union-bound exponent per
node, in nats, is

    Φ(α, β) = H(α, β − α, 1 − β) − 8 · KL*

where KL* is the smallest KL(x ‖ ρ ⊗ ρ) over couplings x with both marginals
ρ = (α, 1 − β, β − α) and no mass on the forbidden pairs. This is the exponent
F of Lemma B.2 of the report, which is in bits: Φ = F · ln 2. The two are
derived differently and agree within 1.5 × 10⁻¹⁴ bits.

The script bounds KL* from below by the Donsker–Varadhan dual value at the
symmetric scaling, so an imprecise numerical solution can only weaken the
expansion, never overstate it. The test compares this bound with the exact
minimum over couplings. It also compares the exponent with the exact expected
number of violating pairs (S, T) on small graphs: every pair of sizes for
64 nodes and a sample for 256.

E(α) is the largest β found with Φ(α, β) below the negative margin. As in the
report, it is computed at α = 0.001, 0.002, …, 0.800 and used between these
points as its value at the point below. That is a lower bound, because a
larger set contains a smaller one with the same neighbours. No expansion is
claimed outside the range. One size of T per size of S suffices, because N[S]
can be padded to exactly βn nodes.

## Margin

At Φ = 0 the computed exponent is floating-point noise: −2.05 × 10⁻¹⁴ nats at
α = 0.1. Like the report, the script therefore requires F < −10⁻⁴ bits per
node (6.93 × 10⁻⁵ nats) instead of F < 0. The margin lowers E by at most
2.7 × 10⁻⁵, and the values of B₃ and B₂ published in the report are reproduced
to all four decimals.

The margin also covers the polynomial factors of the union bound. The script
allows for:

- Stirling factors of at most 3 ln(2π · 8n) + 1/2;
- at most (8n + 1)² slot-flow matrices;
- 800 curve points and 13 layers.

A graph failure probability of 2⁻¹²⁸ then needs this margin per node:

| Nodes | Sector | Margin needed (bits) | n × margin (bits) | Reached |
| ---: | --- | ---: | ---: | :---: |
| 2^30 | 32 GiB | 2.9 × 10⁻⁷ | 107,374 | yes |
| 2^24 | 512 MiB | 1.7 × 10⁻⁵ | 1,678 | yes |
| 2^18 | 8 MiB | 9.7 × 10⁻⁴ | 26 | no |

The allowance is generous: on the small graphs of the test, the exact expected
number of violating pairs exceeds exp(n · Φ) by about one nat (ln 8 / 2) at
most. For n = 2^30 the report computes the union bound with exact factorials
and gets at most 2^−107,386 for each curve point and 2^−107,376 for all 800.
The 8 MiB profile reuses the proof budget only to compare timings.

## Layers

The layer program follows Section 3.4 and Appendix A.1 of the report:

- ε = 0.20, and a chain ends when a layer reaches 0.80n forward dependencies;
- the adversary splits its budget on a grid of step h;
- a chain of s steps needs 2s + 1 layers.

Conservative rounding favours the adversary at every grid value and gives the
bound; favourable rounding shows how tight it is. A conservative run on any
grid is a valid bound, and a finer grid wastes less.

Grid values make exact ties common: the start of a chain can equal the
fraction the adversary needs. Under conservative rounding the script counts a
tie for the adversary, and under favourable rounding against it, so floating
point never decides a result.

The program reproduces the report:

- the B₂ and B₃ rows of the table in Section 3.4 (h = 0.001);
- Proposition 3.5: 5 steps at δ = 0.002 (h = 0.001) and 6 steps at δ = 0.013
  (h = 0.0005) with B₃, 7 and 8 steps with B₂, with both roundings;
- the limit of Section 3.5: 13 layers at δ = 0.0133 and no number of layers at
  δ = 0.0134 (h = 0.0005).

A line-by-line port of the report's scripts gives the same number of steps in
all 168 compared cases: 14 values of δ, three layer grids, both roundings, B₂
and B₃.

Layers with B₃ (conservative / favourable; "–" means more than 17 layers):

| δ | Challenges per layer | h = 0.002 | h = 0.001 | h = 0.0005 |
| ---: | ---: | :---: | :---: | :---: |
| 0.002 | 3,463 | 11 / 11 | 11 / 11 | 11 / 11 |
| 0.005 | 1,383 | 13 / 11 | 13 / 11 | 13 / 11 |
| 0.01 | 690 | 13 / 13 | 13 / 13 | 13 / 13 |
| 0.01275 | 540 | 13 / 13 | 13 / 13 | 13 / 13 |
| 0.013 | 530 | – / 13 | 13 / 13 | 13 / 13 |
| 0.0133 | 518 | – / 13 | – / 13 | 13 / 13 |
| 0.0134 | 514 | – / 13 | – / 13 | – / 13 |

With conservative rounding, 13 layers hold up to δ = 0.01278 at h = 0.002, up
to δ = 0.0131 at h = 0.001 and up to δ = 0.0133 at h = 0.0005. δ = 0.005 is an
exact tie, so it gets 13 layers on all three grids; δ = 0.0049 still gets 11
at h = 0.001.

Computing the curve at every α of the layer grid (`--curve-step=0.0001`)
raises E by up to 0.009. The layer counts above stay the same, except that
δ = 0.0134 then gets 13 layers at h = 0.0005. The budget does not rely on it.

## Scope

The bound is as strong as the report's Proposition 3.5, which is a result in
the pebbling game for ε = 0.20. It assumes that every layer is
(n, 0.80n, βn)-depth-robust and that the permutation behind the expander is
uniformly random; the implementation uses a Feistel permutation. The report is
a draft and lists the step from the pebbling game to the labeling game as open.

## Budget

Challenges per layer are c = ⌈λ / −log₂(1 − δ)⌉ with λ = 10, giving 530 at
δ = 0.013. Rounding up per partition gives 36 × ⌈530 / 36⌉ = 36 × 15 = 540
challenges per layer. That covers δ = 0.01275, which gives 13 layers on all
three layer grids. The proof has 13 × 540 = 7,020 challenge instances and
36 × 192 = 6,912 bytes.

With 22 parents, 13 layers and 15 challenges per partition, the estimated
circuit size is about 126.5M, below 2^27 = 134.2M. Sixteen challenges per
partition are estimated at about 0.5% above 2^27. Both figures are estimates;
measure the constraint count on a remote machine before generating parameters.
For extra margin, δ = 0.012 needs 575 challenges, or 39 × 15 = 585.

The report proves 11 layers for δ ≤ 0.002, which means 3,463 challenges per
layer, or 204 partitions of 17. The same computation still gives 11 layers at
δ = 0.0049 (1,412 challenges, 84 partitions of 17), a range the report does
not state. In both cases the extra C2 work outweighs the two layers saved in
PC1 and unseal.

## Reproduce

The script uses only Node built-ins:

```sh
node scripts/zigzag-undirected-bound.mjs
node scripts/zigzag-undirected-bound.mjs --deltas=0.0131,0.0132 --grids=0.001
node scripts/zigzag-undirected-bound.mjs --margin-bits=0 --curve-step=0.0001
node --test scripts/test/zigzag-undirected-bound.test.mjs
```

The default run takes about 5 s and the test about 7 s. The test checks:

- the KL bound and the exponent against exact counts;
- the margin and the published values of B₃ and B₂;
- the table of Section 3.4, Proposition 3.5 and the limit of Section 3.5;
- the tie rule;
- the layer counts for the budget in `bench-zigzag.sh`, also with other
  margins and a finer curve.

With the curve at every α of the layer grid and margins in nats, the script
also reproduces the Python analysis behind the first parameter choice: E
agrees within 1.5 × 10⁻¹⁴, and the layer counts match in all 68 compared cases.
