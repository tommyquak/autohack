import numpy as np
import pandas as pd
import pytest

from triage.data import load_cdms


@pytest.fixture
def cdm_csv(tmp_path):
    """Tiny SYNTHETIC CDM file covering every tier (not real data - shapes only)."""
    rng = np.random.default_rng(0)
    rows = []
    # event_id, (risk, max_risk_estimate, miss_distance) for the final CDM
    finals = {1: (-30.0, -8.0, 20_000), 2: (-5.0, -4.6, 8_000), 3: (-3.5, -3.2, 3_000), 4: (-9.0, -7.0, 600)}
    for event_id, (risk, upper, miss) in finals.items():
        for k, t in enumerate([5.5, 3.2, 1.8, 0.6]):
            drift = (3 - k) * 0.3
            rows.append(
                {
                    "event_id": event_id,
                    "time_to_tca": t,
                    "mission_id": 7,  # extra column the loader must drop
                    "risk": risk - drift,
                    "max_risk_estimate": upper - drift,
                    "miss_distance": miss * (1 + drift),
                    "relative_speed": 12_000 + rng.normal(0, 100),
                    "relative_position_r": rng.normal(0, 200),
                    "relative_position_t": rng.normal(0, 2_000),
                    "relative_position_n": rng.normal(0, 2_000),
                    "c_object_type": "DEBRIS" if event_id % 2 else "PAYLOAD",
                    "c_sigma_r": abs(rng.normal(50, 10)),
                    "t_sigma_r": abs(rng.normal(5, 1)),
                    "F10": 150.0,
                    "AP": 12.0,
                }
            )
    path = tmp_path / "cdm_tiny.csv"
    pd.DataFrame(rows).to_csv(path, index=False)
    return path


@pytest.fixture
def cdms(cdm_csv):
    return load_cdms(cdm_csv)
