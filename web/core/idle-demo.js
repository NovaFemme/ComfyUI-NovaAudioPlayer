/**
 * idle-demo.js — what the player shows before it has anything to play.
 *
 * A node that has never run used to be three widgets and a title. It now draws
 * the real player, and this fills the real signal bag with synthetic material
 * so the visualisers move: an idle node looks like the thing it is, which is
 * the only honest way to advertise a player.
 *
 * NOT AUDIO. Nothing is ever played. Every browser blocks autoplay anyway, and
 * a node graph that made noise when you dropped a node into it would be a
 * misfeature even if they didn't. This synthesises the *measurements* a player
 * would be showing, and the transport is inert.
 *
 * Cheap on purpose: one pass over the bins at 15 fps, no allocation after the
 * first call, and it stops the instant real audio arrives. A graph with a
 * dozen idle players must not cost anything anyone notices.
 */

// A slow loop of imaginary music: a four-on-the-floor pulse under a pad that
// drifts through the spectrum, so the waveform, the spectrum, the goniometer
// and the meters all have something characteristic to show.
const BPM = 104;
const BEAT = 60 / BPM;
const LOOP = BEAT * 32;              // the "take" repeats every 32 beats

function envelope(t) {
    // Kick on every beat, with a snare-ish accent on 2 and 4.
    const beat = (t / BEAT) % 1;
    const bar = Math.floor(t / BEAT) % 4;
    const kick = Math.exp(-beat * 9);
    const accent = (bar === 1 || bar === 3) ? Math.exp(-beat * 16) * 0.6 : 0;
    // A slow swell across the loop so the meters are not metronomic.
    const swell = 0.55 + 0.45 * Math.sin((t / LOOP) * Math.PI * 2);
    return Math.min(1, (0.35 + kick * 0.65 + accent) * swell);
}

/**
 * Fill `sig` with one frame of synthetic signal.
 *
 * @param sig  the engine's shared signal bag, buffers already allocated
 * @param t    seconds since the demo started
 */
export function fillDemoSignal(sig, t) {
    const env = envelope(t);
    const bins = sig.binCount;
    const nyquist = sig.sampleRate / 2;

    // ---- spectrum ---------------------------------------------------------
    // A pink tilt with a formant that sweeps slowly, plus the bass pulse. Built
    // in dBFS because that is what the float path carries; the byte array is
    // derived from it, exactly as the real analyser derives one from the other.
    const sweep = 900 * Math.pow(2, Math.sin(t * 0.11) * 1.6);   // ~300-2700 Hz
    for (let i = 1; i < bins; i++) {
        const hz = (i / bins) * nyquist;

        // -6 dB per octave from 40 Hz: the shape most produced music has.
        // The overall level sits where a real bin sits, not where a real TRACK
        // sits: the byte path maps -100..-30 dBFS onto 0-255, so a spectrum
        // drawn at track level would peg every low bin at 255 and the view
        // would be a solid block.
        let db = -40 - 6 * Math.log2(Math.max(hz, 40) / 40);

        // The pad: a broad resonance that moves.
        const rel = Math.log2(Math.max(hz, 20) / sweep);
        db += 16 * Math.exp(-(rel * rel) / 0.6);

        // The kick, which lives under 120 Hz and follows the envelope.
        if (hz < 120) db += 20 * env * (1 - hz / 120);

        // A little air so the top is not a dead straight line.
        db += Math.sin(hz * 0.0021 + t * 1.7) * 2.5 - (1 - env) * 6;

        if (db > -32) db = -32;
        if (db < -110) db = -110;

        if (sig.freqDb) sig.freqDb[i] = db;
        // Byte path: the same -100..-30 window the real analyser maps onto.
        const b = ((db + 100) / 70) * 255;
        sig.freq[i] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    if (sig.freqDb) sig.freqDb[0] = -140;
    sig.freq[0] = 0;

    // ---- time domain ------------------------------------------------------
    // Three partials and the kick. The right channel is delayed a fraction of a
    // cycle so the goniometer draws an ellipse rather than a diagonal line and
    // the correlation meter sits where real music sits.
    const n = sig.timeL.length;
    const sr = sig.sampleRate;
    for (let i = 0; i < n; i++) {
        const s = t + i / sr;
        const kick = Math.sin(2 * Math.PI * 55 * s) * Math.exp(-((s / BEAT) % 1) * 9);
        const body = Math.sin(2 * Math.PI * sweep * 0.5 * s) * 0.35
                   + Math.sin(2 * Math.PI * sweep * s + 1.1) * 0.22;
        const l = (kick * 0.7 + body) * env * 0.55;
        // Decorrelated enough that the goniometer draws a shape and the
        // correlation meter reads like music (~0.8) rather than like a mono
        // file with a phase trim (~0.98).
        const r = (kick * 0.7 + body * 0.55
                   + Math.sin(2 * Math.PI * sweep * 1.5 * s + 2.3) * 0.28
                   + Math.sin(2 * Math.PI * sweep * 0.33 * s + 0.7) * 0.2)
                  * env * 0.55;
        sig.timeL[i] = l > 1 ? 1 : l < -1 ? -1 : l;
        sig.timeR[i] = r > 1 ? 1 : r < -1 ? -1 : r;
    }

    // ---- meters -----------------------------------------------------------
    let sumL = 0, sumR = 0, cross = 0;
    for (let i = 0; i < n; i++) {
        sumL += sig.timeL[i] * sig.timeL[i];
        sumR += sig.timeR[i] * sig.timeR[i];
        cross += sig.timeL[i] * sig.timeR[i];
    }
    const rmsL = Math.sqrt(sumL / n), rmsR = Math.sqrt(sumR / n);
    const norm = v => {
        const db = 20 * Math.log10(Math.max(v, 1e-6));
        return Math.max(0, Math.min(1, (db + 60) / 60));
    };
    sig.levelL = norm(rmsL);
    sig.levelR = norm(rmsR);
    sig.peakHold = Math.max(sig.levelL, sig.levelR);
    sig.corrRaw = cross / (Math.sqrt(sumL * sumR) || 1);
    sig.clip = false;

    // ---- transport --------------------------------------------------------
    // A playhead that moves, over a plausible take length, so the scrub bar and
    // any renderer keyed to progress are not frozen at zero.
    sig.duration = LOOP;
    sig.currentTime = t % LOOP;
    sig.progress = sig.currentTime / LOOP;
    sig.playing = true;
    sig.hasData = true;
    sig.frame++;
}

// Shown in the badge row while the demo runs. Cycled rather than fixed: the
// node is a shop window before it is a tool, and a line that changes is read
// twice.
// What the voiceover actually says. Shown while it plays, because a caption
// that disagrees with the audio it captions is worse than no caption: the eye
// wins, and then the line you recorded is the one nobody read.
export const INTRO_LINE = "measures the take, enjoy the vibe";

export const SLOGANS = [
    "twelve ways to look at a waveform",
    INTRO_LINE,
    "your ears are the instrument — this is the tape measure",
    "nothing here is a guess. every number names its threshold",
    "drop an AUDIO in and it stops pretending",
];

export function slogan(t) {
    return SLOGANS[Math.floor(t / 6) % SLOGANS.length];
}
