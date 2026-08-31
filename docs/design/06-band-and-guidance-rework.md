# freq_percentages + projected_guidance rework

Follows [05-renderer-review.md](05-renderer-review.md). Those were the two design
points flagged rather than changed during the review.

## freq_percentages — shares of total energy

**Was:** four disjoint sample windows (60-250, 500-2k, 4-6k, >16k) leaving
0-60, 250-500, 2-4k and 6-16k uncounted, presented as percentages. The figures
were shares of an arbitrary subset, so they shifted when the gaps did.

**Now:** `BAND_EDGES_HZ = [0, 250, 2000, 6000, Infinity]` — contiguous, DC to
Nyquist. Every bin above the floor lands in exactly one band; the four figures
are true fractions of total energy and sum to 100%.

Also: a track behind each bar so an empty band still reads as a band; the range
hint moved to the unfilled end of the track (it was drawn over its own bar).

`combined_suite`'s band strip was aligned to the same edges.

**Trap for later:** the first edge must stay `0` and the last `Infinity`. An
early version used `20` as the first edge and silently dropped the two bins
below 20 Hz — the test caught it as 982/984 bins counted and a 99.4% sum.

## projected_guidance — nothing can rail now

**Was:**

```
velocity += ETA * (target - measured)
position += velocity          // clamped 0..1
```

`position` measured nothing — a free-running accumulator with no restoring
force. For any sustained signal the velocity settled non-zero and the position
ran to a rail. Since audio is louder than the target curve most of the time,
that rail was 0, so the view was a flat line along the bottom.

**Now** every drawn quantity is bounded and derived from the audio. This
renderer was later rewritten again — see
[07-apg-artifact-meter.md](07-apg-artifact-meter.md).

## Verification

* sustained loud material for 6 s → **0/2048 bins railed at 0**;
* then quiet for 6 s → tracks the audio down rather than sticking;
* band shares sum to 99.9% and **984/984** above-floor bins land in a band.

**Testing note:** paneltest and scopetest both reported failures when run
against a config directory left over from previous runs — the theme already
held the colour the test was about to set. Delete `config/*.json` before those
two suites.
