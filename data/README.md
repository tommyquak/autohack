# Data

## Get the full dataset (once per person)
The organisers' Google Drive folder (link in the Airbus Track PDF) only opens with an **NUS account**.
Download the Challenge #1 zip (`Challenge #1/archive(1).zip`) and unzip it into `data/raw/`:

```
data/raw/train_data.csv
data/raw/test_data.csv
```
`data/raw/` is gitignored: the CSVs are too big for GitHub and access is restricted by the organisers. Never commit them.

## `data/sample/cdm_sample.csv`
A small subsample of real events (all tiers represented), committed so tests, CI and dashboard work
without the full download. Regenerate with `uv run python -m triage.sample` once the raw data is in place.

## Columns we may use (Challenge #1 rules)
| column | meaning | unit (verify on load) |
|---|---|---|
| `event_id` | conjunction event; one event has many CDMs over time | - |
| `time_to_tca` | time from this CDM to closest approach | days |
| `miss_distance` | predicted distance at closest approach | m |
| `relative_speed` | relative speed at closest approach | m/s |
| `relative_position_r/t/n` | relative position in radial / along-track / normal frame | m |
| `c_object_type` | type of the other object (debris, payload, rocket body, ...) | - |
| `c_sigma_r`, `t_sigma_r` | radial position uncertainty, chaser / target | m |
| `max_risk_estimate` | upper bound on collision probability | log10 |
| `F10`, `AP` | solar flux and geomagnetic index (drive drag uncertainty) | - |
| `risk` | **label only**: log10(Pc). Never a model input. | log10 |

Tier thresholds live in `triage/tiers.py`.
