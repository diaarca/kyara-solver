# Mathematical model

For a booster b and card c, let N_bc be the number of copies in one opening.
The dataset stores both E[N_bc] and Pr(N_bc >= 1). Neither is assumed to equal
the other. The collector does not assume that cards within a rarity are uniform.

For historical median m_c, configured selling fee f, and opening cost C_b:

    P_b = sum_c E[N_bc] * m_c * (1-f) - C_b

For selected universes, let M contain only cards that are not marked owned:

    U_b = sum_{c in M} Pr(N_bc >= 1)

U_b is the expected number of distinct new cards in one opening. It is not the
probability of getting any new card or of completing an entire universe.
Linearity of expectation makes this valid even when occurrences of different
cards are dependent. A repeated copy of one new card contributes at most one.
Every missing card has equal value across selected universes.

For each objective, use its minimum and maximum over the same eligible booster
set to map values to [0,1]. A constant objective contributes zero. Pure objectives
do not require the inactive objective's data; unknown profit is shown as null.

    score_b = alpha * normalized(P_b) + (1-alpha) * normalized(U_b)

For alpha=0.5, the objectives have equal influence over their observed ranges.
Changing the eligible booster set can change that tradeoff. This weight does
not mean a fixed chakra value per missing card, nor a 50% probability of progress.

The C++ CP-SAT model creates a Boolean x_b for each eligible booster:

    sum_b x_b = 1
    maximize sum_b x_b * round(1,000,000 * score_b)

One worker and a fixed seed make solving deterministic. Scores are rounded to
six decimal places. An integer secondary coefficient selects the lexicographically
smallest booster ID in a quantized tie; multiplying primary coefficients by n+1
keeps this tie-break subordinate. Candidate count is bounded to protect integer
arithmetic. The solver requires an OPTIMAL result and checks its winner against
the reported ranking. Every candidate is scored, so a direct enumeration would
also suffice for this first model; CP-SAT is used as requested and can support
future budget/purchase constraints.

## Probability models accepted by the collector

An explicitly verified `independent_slots` model describes slot groups, each
with k independent replacement draws from a complete card distribution p_sc:

    E[N_bc] = sum_s k_s * p_sc
    Pr(N_bc >= 1) = 1 - product_s (1-p_sc)^k_s

A guaranteed slot is a distribution with probability 1 for its guaranteed card,
or a verified distribution over a guaranteed rarity. Independence and replacement
must be confirmed before using this format. Do not use it for duplicate prevention,
conditional pity rules, or draws without replacement.

Alternatively, a verified `moments` model supplies the two quantities directly.
It supports dependent mechanics when the moments have been calculated or published
correctly. Unknown mechanics leave the booster unranked.

Full collection additionally supports `published_rates_with_rarity_samples`:
complete pools and all published slot/rarity/per-card aggregate rates are checked,
plus at least one fresh character-detail probability per active rarity in each
pool. This avoids fetching thousands of redundant character details. The model
still explicitly assumes independent replacement draws and within-rarity
uniformity; sample validation is recorded separately from exhaustive validation.
When a booster overrides base weights, normalized published slot percentages can
be used. Their four-decimal percentage rounding is recorded, with conservative
error bounds applied to aggregate and sample comparisons. A contradictory
published/detail recipe is excluded, as observed for the daily pack.

## Hand-checked synthetic fixture

`Profit pack` costs 20 and has two replacement draws, each selecting card 1
(median 10) or card 4 (median 100) with probability 1/2. Expected copies of each
are 1, giving expected proceeds 110 and profit 90. The occurrence probability
of card 1 is 1-(1/2)^2 = 0.75.

`Clover pack` costs 10 and draws twice from cards 1 and 2 with equal probability.
Their medians are 10 and 6: proceeds 16, profit 6. If both are missing Black Clover
cards, expected distinct new cards are 0.75+0.75 = 1.5.

Marking card 1 owned reduces that completion value to 0.75 while profit stays 6.
The free-compatible pack guarantees card 2, so it becomes the completion winner
among paid candidates when only card 2 is missing.

These values are fictional fixture definitions, not statements about live Kyara.

## Interpretation limits

Resale at historical medians is an estimate. The model does not represent sale
timing, bid depth, market impact, or special variant premiums. Availability is
evaluated at snapshot time and reported with snapshot age. Collection is manual:
the program does not open packs, trade, place orders, or update ownership from
actual openings. Re-run with updated ownership after obtaining new cards.
