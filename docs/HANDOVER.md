# Handover - Autonomous SG 2026, Airbus Challenge #1 (written 31 Oct, ~11:15)

Repo: https://github.com/tommyquak/autohack (private) · local: `~/Desktop/autonomous-sg`
Plan: `docs/PLAN.md` · roles/timeline: `docs/TEAM.md` · interfaces: `docs/CONTRACT.md`

## Where things stand
| PR | Branch | State |
|---|---|---|
| #1 CI (ruff + pytest), protected main | - | **merged** |
| #2 Scaffold: tiers, data loader, baselines, eval, events contract, sample data, team docs | - | **merged** |
| #3 Model: targeted demotion classifier | `feat/model` | **open** - CI should be green; Kalent re-runs eval, then merge |

Local checkout is on `feat/model`.

## Model result (test set, 24,484 CDMs)
| | crit recall | false Elevated | flagged (workload) | under-tier | macro F1 |
|---|---|---|---|---|---|
| max_risk_estimate rule (baseline) | 100% | 4,526 | 54.2% | 0 | 0.841 |
| **model** | **100%** | **2,206 (-51%)** | **44.7%** | **1 CDM** | **0.910** |

How: model acts only where the baseline over-warns (Elevated purely from `max_risk_estimate` in [1e-6, 1e-4) with miss > 5 km). HistGradientBoostingClassifier, monotonic constraints, event-grouped 5-fold CV; threshold = 1% quantile of out-of-fold scores of truly-Elevated rows → ≥99% recall guarantee. Never touches Critical, never demotes diluted covariance (sigma sentinel 63,781,360 m).
First attempt (regression on log Pc) flagged 100% of CDMs - eval caught it. Use this in the pitch (lvl 500 style).
The 1 under-tiered CDM = our honest failure case to show.

## Local-only files (gitignored - survive a restart, not on GitHub)
- `data/raw/train_data.csv`, `data/raw/test_data.csv` (copied from ~/Downloads)
- `reports/model.joblib`, `reports/metrics.json` (rebuild: commands below)

## Commands
```
cd ~/Desktop/autonomous-sg
uv run python -m triage.train          # ~1 min -> reports/model.joblib
uv run python -m triage.evaluate       # -> reports/metrics.json + table
uv run python -m triage.build_events   # -> reports/events.json (full test set)
uv run pytest -q && uv run ruff check . # same as CI
```

## Next steps (in order)
1. **Merge PR #3** once CI is green and Kalent has re-run the eval table.
2. **API** (Tommy): in `server.py` add `/api/summary`, `/api/events` (list, no history), `/api/events/{id}`, `/api/metrics`, `/api/explain/{id}` (Claude from structured fields only + template fallback when no key). Serve dashboard at `/`, move chat to `/chat`. Reads `reports/events.json` + `reports/metrics.json`.
3. **Dashboard** (Reagan, "WOW" - use `/impeccable overdrive`): plan agreed:
   - Triage funnel: all events, x = time to TCA, y = log miss distance, threshold bands; animated workload drop baseline → model with "Critical caught 100%" locked.
   - 3D encounter view (three.js): own sat at origin, R/T/N axes, translucent 1 km / 5 km shells, each event's CDM history as a converging trail of predicted closest-approach points with shrinking uncertainty. Label "relative position, enlarged, not to scale". No fake orbits.
   - Ranked event queue, detail card (rules fired, Pc vs thresholds, risk-over-time with bands, needs-review badge), 24h-slot strip across the 7-day horizon (test set has no CDM < 2 days to TCA - say so), Evaluation tab from metrics.json.
   - Design: SDTH "Night Instrument" (`~/Desktop/SDTH/DESIGN.md`, `.impeccable/design.json`): #080a0b ground, hairlines not cards, uppercase mono labels, tabular mono figures, Spline Sans Mono + Archivo. Colours: phosphor #3fe0a0 below threshold, amber #e8a33c elevated, red #ff4a3d critical, blue #5ea9ff own sat. Vanilla ES modules + three.js from CDN, no build step.
4. **Eval extras** (Kalent): lead-time chart, failure-case write-up, optional 45-min "heavier model" comparison (TabPFN or small sequence model) for honesty.
5. **Integration** (Franky): explain endpoint + dashboard interactions, dilution / needs-review UX.
6. 15:00 feature freeze · 15:45 pitch rehearsed · ~16:00 submit (confirm official deadline).

## Gotchas
- `risk` is label-only (rules say allowed columns only). Never add it as a feature.
- Split by `event_id` always (GroupKFold) - otherwise scores leak.
- "Below threshold", never "safe". Label anything synthetic.
- main is protected: branch → PR → green CI → squash merge. Don't force-push; merge `origin/main` into your branch instead.
- Organisers' Drive only opens with an NUS account.
