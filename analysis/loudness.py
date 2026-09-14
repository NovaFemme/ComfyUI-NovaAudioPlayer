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


def true_peak_db(
    x: torch.Tensor,
    sample_rate: int,
    oversample: int = 4,
    chunk_seconds: float = 1.0,
) -> float:
    """Practical 4x oversampled peak estimate without a huge full-track allocation."""
    if oversample <= 1:
        return sample_peak_db(x)

    chunk = max(1024, int(sample_rate * chunk_seconds))
    max_peak = torch.tensor(0.0, device=x.device)

    # Small overlap prevents interpolation edge misses at chunk boundaries.
    overlap = 8

    for start in range(0, x.shape[-1], chunk):
        lo = max(0, start - overlap)
        hi = min(x.shape[-1], start + chunk + overlap)
        part = x[:, lo:hi].float().unsqueeze(0)
        up = F.interpolate(
            part,
            size=part.shape[-1] * oversample,
            mode="linear",
            align_corners=False,
        )
        max_peak = torch.maximum(max_peak, torch.max(torch.abs(up)))

    return float((20.0 * torch.log10(max_peak + EPS)).item())
