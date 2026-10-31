"""Operational risk tiers - the deterministic rule layer.

Thresholds are the ones given in the challenge, following the NASA Conjunction
Assessment Handbook (NASA/SP-20205011318) and ESA Space Debris Office practice:

    Safe      Pc < 1e-6           and  miss distance > 5 km
    Elevated  1e-6 <= Pc < 1e-4   or   1 km <= miss distance <= 5 km
    Critical  Pc >= 1e-4          or   miss distance < 1 km

The worse of the Pc tier and the miss-distance tier wins. `risk` in the dataset
is log10(Pc), so the Pc thresholds are -6 and -4 in risk units.
"""

from enum import IntEnum

import numpy as np

RISK_ELEVATED = -6.0  # log10(1e-6)
RISK_CRITICAL = -4.0  # log10(1e-4)
MISS_ELEVATED_M = 5_000.0  # 5 km, dataset miss_distance is in metres
MISS_CRITICAL_M = 1_000.0  # 1 km


class Tier(IntEnum):
    SAFE = 0
    ELEVATED = 1
    CRITICAL = 2


TIER_NAMES = {Tier.SAFE: "Below threshold", Tier.ELEVATED: "Elevated", Tier.CRITICAL: "Critical"}


def pc_tier(risk):
    """Tier from log10(Pc). Accepts a scalar or array; returns int array/scalar."""
    r = np.asarray(risk, dtype=float)
    out = np.where(r >= RISK_CRITICAL, Tier.CRITICAL, np.where(r >= RISK_ELEVATED, Tier.ELEVATED, Tier.SAFE))
    return out.astype(int)


def miss_tier(miss_m):
    """Tier from miss distance in metres."""
    m = np.asarray(miss_m, dtype=float)
    out = np.where(m < MISS_CRITICAL_M, Tier.CRITICAL, np.where(m <= MISS_ELEVATED_M, Tier.ELEVATED, Tier.SAFE))
    return out.astype(int)


def true_tier(risk, miss_m):
    """Ground-truth tier for a CDM: the worse of the Pc rule and the miss-distance rule."""
    return np.maximum(pc_tier(risk), miss_tier(miss_m))


def reasons(risk, miss_m) -> list[str]:
    """Human-readable list of which rules fired for one CDM (risk may be a predicted/upper-bound value)."""
    out = []
    if risk >= RISK_CRITICAL:
        out.append(f"Pc 10^{risk:.2f} >= 1e-4 (critical threshold)")
    elif risk >= RISK_ELEVATED:
        out.append(f"Pc 10^{risk:.2f} in [1e-6, 1e-4) (elevated band)")
    if miss_m < MISS_CRITICAL_M:
        out.append(f"miss distance {miss_m:.0f} m < 1 km")
    elif miss_m <= MISS_ELEVATED_M:
        out.append(f"miss distance {miss_m / 1000:.2f} km within 1-5 km")
    return out or ["Pc < 1e-6 and miss distance > 5 km"]
