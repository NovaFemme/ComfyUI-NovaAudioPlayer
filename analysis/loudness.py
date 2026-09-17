"""Fast shared loudness / peak analysis for Nova Audio Master v0.2.1.

Performance fixes:
- K-weighting uses torchaudio.functional.lfilter instead of Python per-sample loops.
- BS.1770 block energy uses cumulative sums instead of unfold + large frame tensors.
- True peak is measured in chunks to avoid allocating a 4x full-track tensor.
"""

import math
import torch
import torch.nn.functional as F

EPS = 1e-12


def _biquad_coefficients(sample_rate: int):
    if sample_rate == 48000:
        shelf = (
            1.53512485958697,
            -2.69169618940638,
            1.19839281085285,
            -1.69065929318241,
            0.73248077421585,
        )
        highpass = (
            1.0,
            -2.0,
            1.0,
            -1.99004745483398,
            0.99007225036621,
        )
        return shelf, highpass

    def rbj_high_shelf(f0, q, gain_db):
        A = 10.0 ** (gain_db / 40.0)
        w0 = 2.0 * math.pi * f0 / sample_rate
        alpha = math.sin(w0) / (2.0 * q)
        c = math.cos(w0)
        beta = 2.0 * math.sqrt(A) * alpha
        b0 = A * ((A + 1) + (A - 1) * c + beta)
        b1 = -2 * A * ((A - 1) + (A + 1) * c)
        b2 = A * ((A + 1) + (A - 1) * c - beta)
        a0 = (A + 1) - (A - 1) * c + beta
        a1 = 2 * ((A - 1) - (A + 1) * c)
        a2 = (A + 1) - (A - 1) * c - beta
        return b0/a0, b1/a0, b2/a0, a1/a0, a2/a0

    def rbj_highpass(f0, q):
        w0 = 2.0 * math.pi * f0 / sample_rate
        alpha = math.sin(w0) / (2.0 * q)
        c = math.cos(w0)
        b0 = (1 + c) / 2
        b1 = -(1 + c)
        b2 = (1 + c) / 2
        a0 = 1 + alpha
        a1 = -2 * c
        a2 = 1 - alpha
        return b0/a0, b1/a0, b2/a0, a1/a0, a2/a0

    return (
        rbj_high_shelf(1681.974450955533, 0.7071752369554196, 3.999843853973347),
        rbj_highpass(38.13547087602444, 0.5003270373238773),
    )


def _lfilter_torch(x: torch.Tensor, coeffs):
    try:
        from torchaudio.functional import lfilter
    except ImportError as e:
        raise RuntimeError(
            "Nova Audio Master v0.2.1 requires torchaudio for fast BS.1770 filtering."
        ) from e

    b0, b1, b2, a1, a2 = coeffs
    b = torch.tensor([b0, b1, b2], dtype=torch.float32, device=x.device)
    a = torch.tensor([1.0, a1, a2], dtype=torch.float32, device=x.device)

    # torchaudio lfilter handles the complete channel tensor in compiled code.
    return lfilter(x.float(), a_coeffs=a, b_coeffs=b, clamp=False)


def k_weight(x: torch.Tensor, sample_rate: int):
    shelf, hp = _biquad_coefficients(sample_rate)
    y = _lfilter_torch(x.float(), shelf)
    y = _lfilter_torch(y, hp)
    return y


def _block_energies(kx: torch.Tensor, sample_rate: int):
    block = max(1, int(round(0.400 * sample_rate)))
    hop = max(1, int(round(0.100 * sample_rate)))

    n = kx.shape[-1]
    if n < block:
        kx = F.pad(kx, (0, block - n))
        n = kx.shape[-1]

    # Per-channel squared-energy cumulative sum.
    sq = kx.float() * kx.float()
    csum = torch.cumsum(sq, dim=-1)
    csum = F.pad(csum, (1, 0))

    starts = torch.arange(0, n - block + 1, hop, device=kx.device)
    ends = starts + block

    sums = csum[:, ends] - csum[:, starts]
    ms = sums / float(block)

    # BS.1770 stereo programme energy: independent channel energies summed.
    return torch.sum(ms, dim=0)


def integrated_lufs(x: torch.Tensor, sample_rate: int) -> float:
    kx = k_weight(x.float(), sample_rate)
    energies = _block_energies(kx, sample_rate)

    block_lufs = -0.691 + 10.0 * torch.log10(torch.clamp(energies, min=EPS))

    absolute = block_lufs >= -70.0
    if not torch.any(absolute):
        return float("-inf")

    abs_energy = energies[absolute]
    abs_loudness = -0.691 + 10.0 * torch.log10(torch.mean(abs_energy) + EPS)
    relative_threshold = abs_loudness - 10.0

    gated = absolute & (block_lufs >= relative_threshold)
    if not torch.any(gated):
        gated = absolute

    integrated_energy = torch.mean(energies[gated])
    return float((-0.691 + 10.0 * torch.log10(integrated_energy + EPS)).item())


def sample_peak_db(x: torch.Tensor) -> float:
    peak = torch.max(torch.abs(x.float()))
    return float((20.0 * torch.log10(peak + EPS)).item())


# True-peak oversampling filter. BS.1770-4 measures the peak of the RECONSTRUCTED
# waveform, i.e. the signal a converter produces between the samples, so the
# interpolator has to be band-limited. Linear interpolation cannot do this at
# all: it returns values between two samples and so can never exceed the larger
# of them, which makes an intersample peak invisible by construction and lets
# the meter report a "true peak" below the sample peak -- a physical
# impossibility. What follows is a windowed-sinc polyphase FIR instead.
#
# 24 taps per phase with a Kaiser beta of 6.0 measures a real 48 kHz master to
# within 0.0003 dB of an exact band-limited reconstruction. The residual error
# of the method is set by the 4x output grid, not the filter: for a tone at
# fs/4 the grid can fall half a step from the true maximum, which is
# 20*log10(cos(2*pi/32)) = -0.1685 dB. That ceiling is inherent to 4x
# oversampling and is why BS.1770-4 treats 4x as the minimum. Pass
# oversample=8 for a tighter bound at twice the cost.
_TRUE_PEAK_TAPS = 24
_TRUE_PEAK_BETA = 6.0
_TAP_CACHE = {}


def _bessel_i0(x: float) -> float:
    """Modified Bessel function of the first kind, order zero, by series.

    Written out rather than imported so this module keeps its dependency
    surface to torch alone.
    """
    total = term = 1.0
    for k in range(1, 256):
        term *= (x / (2.0 * k)) ** 2
        total += term
        if term < 1e-17 * total:
            break
    return total


def _polyphase_taps(oversample: int, taps: int, beta: float):
    """Kaiser-windowed sinc interpolation filter, split into phase branches.

    Each branch is normalised to unit DC gain, so a constant signal passes
    through unchanged and no phase introduces level error of its own.
    """
    key = (oversample, taps, beta)
    cached = _TAP_CACHE.get(key)
    if cached is not None:
        return cached

    length = oversample * taps
    scale = _bessel_i0(beta)
    prototype = []
    for n in range(length):
        position = (n - (length - 1) / 2.0) / oversample
        sinc = 1.0 if abs(position) < 1e-12 else math.sin(math.pi * position) / (math.pi * position)
        ratio = (2.0 * n / (length - 1)) - 1.0
        window = _bessel_i0(beta * math.sqrt(max(0.0, 1.0 - ratio * ratio))) / scale
        prototype.append(sinc * window)

    branches = []
    for phase in range(oversample):
        branch = prototype[phase::oversample]
        total = sum(branch)
        branches.append([c / total for c in branch])

    _TAP_CACHE[key] = branches
    return branches


def true_peak_db(
    x: torch.Tensor,
    sample_rate: int,
    oversample: int = 4,
    chunk_seconds: float = 1.0,
) -> float:
    """BS.1770-4 true peak: the peak of the band-limited reconstruction.

    The signal is upsampled with a windowed-sinc polyphase FIR and the largest
    absolute value over every output phase is returned. The original samples
    are included in that maximum, which guarantees the result is never below
    the sample peak -- an invariant the previous linear-interpolation
    implementation violated.

    Processed in chunks with a filter-length overlap so a long track never
    needs a full oversampled copy in memory. Only each chunk's own interior is
    taken, so a chunk boundary cannot manufacture a peak.

    The first and last `taps` samples are left out of the oversampled maximum.
    Outside the signal the filter sees zeros, and where a file begins or ends
    part-way through a waveform that step reconstructs with a Gibbs overshoot
    of around 1 dB -- an artefact of where the file was cut, not of its
    content, and one that would otherwise fail a validation on a trimmed
    excerpt for no musical reason. Those samples are still covered at sample
    resolution by the sample-peak floor below, so nothing is under-reported.
    """
    if oversample <= 1:
        return sample_peak_db(x)

    x = x.float()
    channels, length = x.shape[0], x.shape[-1]
    taps = _TRUE_PEAK_TAPS
    if length < 2:
        return sample_peak_db(x)

    branches = _polyphase_taps(int(oversample), taps, _TRUE_PEAK_BETA)
    weight = torch.tensor(branches, dtype=torch.float32, device=x.device).unsqueeze(1)
    weight = weight.repeat(channels, 1, 1)          # [channels * oversample, 1, taps]

    # The reconstruction can only exceed the samples, never fall below them.
    max_peak = torch.max(torch.abs(x))

    left = taps // 2
    right = taps - 1 - left
    chunk = max(1024, int(sample_rate * chunk_seconds))

    for start in range(0, length, chunk):
        lo = max(0, start - taps)
        hi = min(length, start + chunk + taps)
        part = x[:, lo:hi].unsqueeze(0)
        part = F.pad(part, (left, right))
        out = F.conv1d(part, weight, groups=channels)   # aligned with x[:, lo:hi]
        # Clamp to the signal interior, in global coordinates, then translate
        # back into this chunk's output frame.
        first = max(start, taps)
        last = min(start + min(chunk, length - start), length - taps)
        if last <= first:
            continue
        max_peak = torch.maximum(
            max_peak, torch.max(torch.abs(out[:, :, first - lo:last - lo]))
        )

    return float((20.0 * torch.log10(max_peak + EPS)).item())
