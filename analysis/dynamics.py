import math
import torch

EPS = 1e-12


def rms_db(x: torch.Tensor) -> float:
    x = x.float()
    rms = torch.sqrt(torch.mean(x * x) + EPS)
    return float(20.0 * torch.log10(rms + EPS).item())


def sample_peak_db(x: torch.Tensor) -> float:
    peak = torch.max(torch.abs(x.float()))
    return float(20.0 * torch.log10(peak + EPS).item())


def crest_db(x: torch.Tensor) -> float:
    return sample_peak_db(x) - rms_db(x)


def lr_correlation(x: torch.Tensor) -> float:
    if x.shape[0] < 2:
        return 1.0
    l = x[0].float() - x[0].float().mean()
    r = x[1].float() - x[1].float().mean()
    den = torch.sqrt(torch.mean(l * l) * torch.mean(r * r)) + EPS
    return float(torch.clamp(torch.mean(l * r) / den, -1.0, 1.0).item())


def dc_offset(x: torch.Tensor) -> float:
    return float(torch.mean(x.float()).item())
