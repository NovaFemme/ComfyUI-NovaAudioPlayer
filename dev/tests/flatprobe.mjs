// Does a limiter ceiling BELOW full scale show up at all?
// The APG CLIP metric only counts samples at the digital ceiling. If ACE-Step
// output is limited or normalised below 0 dBFS — which NovaFemme's bench node says
// it is, peak -1.32 dBFS — then oversaturation never produces a digital clip
// and the metric reads 0.00% no matter how hard the take is being squashed.
const SR = 48000, N = 48000;
const CLIP_LEVEL = 0.999969482421875;

function make(kind) {
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Two tones so the sum genuinely exceeds the ceiling at times.
    let v = 0.7 * Math.sin(2 * Math.PI * 110 * i / SR)
          + 0.55 * Math.sin(2 * Math.PI * 173 * i / SR);
    if (kind === "clean") v *= 0.7;
    else if (kind === "digital") v = Math.max(-1, Math.min(1, v));
    else if (kind === "limited") {
      const ceil = 0.859;                    // -1.32 dBFS, NovaFemme's measured peak
      v = Math.max(-ceil, Math.min(ceil, v));
    } else if (kind === "bass") {
      // A loud low sine: the case a naive flat-top detector calls a false
      // positive, because consecutive samples near its apex barely differ.
      v = 0.95 * Math.sin(2 * Math.PI * 50 * i / SR);
    }
    x[i] = v;
  }
  return x;
}

const clipPct = x => {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= CLIP_LEVEL) n++;
  return (n / x.length) * 100;
};

// Flat-top detector: runs of consecutive samples that barely move, at a level
// high enough that it cannot be a quiet passage.
function satPct(x, eps, run, level) {
  let n = 0, cur = 1;
  for (let i = 1; i < x.length; i++) {
    const flat = Math.abs(x[i] - x[i - 1]) <= eps && Math.abs(x[i]) >= level;
    if (flat) { cur++; } else { if (cur >= run) n += cur; cur = 1; }
  }
  if (cur >= run) n += cur;
  return (n / x.length) * 100;
}

console.log("peak / digital-clip %% / flat-top %% at several detector settings\n");
console.log("  material    peak dBFS    CLIP%     SAT(1e-6,4)  SAT(1e-4,4)  SAT(1e-6,8)");
for (const kind of ["clean", "limited", "digital", "bass"]) {
  const x = make(kind);
  let pk = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > pk) pk = Math.abs(x[i]);
  const pdb = 20 * Math.log10(pk);
  console.log(`  ${kind.padEnd(10)} ${pdb.toFixed(2).padStart(8)}  ${clipPct(x).toFixed(3).padStart(8)}  ` +
              `${satPct(x, 1e-6, 4, 0.35).toFixed(3).padStart(11)}  ` +
              `${satPct(x, 1e-4, 4, 0.35).toFixed(3).padStart(11)}  ` +
              `${satPct(x, 1e-6, 8, 0.35).toFixed(3).padStart(11)}`);
}
console.log("\n'bass' must read ~0 in every column — a loud 50 Hz sine is not saturated,");
console.log("but its samples barely move near the apex, so a loose epsilon calls it one.");
