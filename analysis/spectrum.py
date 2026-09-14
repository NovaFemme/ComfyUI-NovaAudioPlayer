import torch
import torch.nn.functional as F

EPS = 1e-12


def band_energy_percentages(x: torch.Tensor, sample_rate: int):
    """Whole-take spectral-energy proportions.

    Spectral balance is intentionally analysed from a mono sum; unlike BS.1770
    loudness this is a tonal-balance diagnostic, not a programme loudness meter.
    """
    mono = x.mean(dim=0).float()
    n_fft = 4096
    hop = 2048

    if mono.numel() < n_fft:
        mono = F.pad(mono, (0, n_fft - mono.numel()))

    window = torch.hann_window(n_fft, device=mono.device)
    spec = torch.stft(
        mono,
        n_fft=n_fft,
        hop_length=hop,
        win_length=n_fft,
        window=window,
        center=True,
        return_complex=True,
    )
    power = (spec.abs() ** 2).mean(dim=1)
    freqs = torch.fft.rfftfreq(n_fft, d=1.0 / sample_rate).to(mono.device)

    nyq = sample_rate / 2.0
    bands = {
        "bass": (20.0, 250.0),
        "mid": (250.0, 2000.0),
        "presence": (2000.0, 6000.0),
        "hf": (6000.0, nyq + 1.0),
    }

    usable = freqs >= 20.0
    total = torch.clamp(power[usable].sum(), min=EPS)
    out = {}
    for name, (lo, hi) in bands.items():
        mask = (freqs >= lo) & (freqs < hi)
        out[name] = float((100.0 * power[mask].sum() / total).item())
    return out
