"""Write data/sample/cdm_sample.csv: a small real subsample (all tiers) safe to commit.

uv run python -m triage.sample
"""

import pandas as pd

from triage.data import EVENT, FEATURES, LABEL, RAW_DIR, SAMPLE_PATH, find_csv, latest_cdm, load_cdms

PER_TIER = 50  # events per final tier


def main():
    df = load_cdms(find_csv("test", RAW_DIR))
    last = latest_cdm(df)
    picked = pd.concat(
        g.sample(min(len(g), PER_TIER), random_state=0) for _, g in last.groupby("true_tier", observed=True)
    )[EVENT]
    sample = df[df[EVENT].isin(picked)][[EVENT, *FEATURES, LABEL]]
    SAMPLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    sample.to_csv(SAMPLE_PATH, index=False)
    print(f"{SAMPLE_PATH}: {sample[EVENT].nunique()} events, {len(sample)} CDMs")


if __name__ == "__main__":
    main()
