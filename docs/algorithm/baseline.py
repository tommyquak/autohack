import sys, numpy as np, pandas as pd, lightgbm as lgb
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import fbeta_score, recall_score, precision_score, f1_score

cols = ['event_id','time_to_tca','miss_distance','relative_speed','relative_position_r',
        'relative_position_t','relative_position_n','c_object_type','c_sigma_r','t_sigma_r',
        'max_risk_estimate','F10','AP','risk','mission_id']
df = pd.read_csv(sys.argv[1], usecols=cols)

def tier(r, md):
    return np.where((r >= -4) | (md < 1000), 2, np.where((r >= -6) | (md <= 5000), 1, 0))

# Kelvins protocol: >=2 CDMs, first >=2d, last <1d. Inputs: CDMs >=2d. Target: last CDM.
g = df.groupby('event_id').time_to_tca
ok = (g.max() >= 2) & (g.min() < 1)
df = df[df.event_id.isin(ok[ok].index)].sort_values(['event_id', 'time_to_tca'], ascending=[True, False])
tgt = df.groupby('event_id').last()                       # closest to TCA
inp = df[df.time_to_tca >= 2]
last = inp.groupby('event_id').last()                     # latest available at 2d cutoff
y_r = tgt.risk; y_t = pd.Series(tier(tgt.risk, tgt.miss_distance), index=tgt.index)
print(f'events: {len(tgt)}  final tiers: {np.bincount(y_t)}  high-risk(>=-6): {(y_r>=-6).sum()}')

def kelvins(pred_r, true_r):
    hr = true_r >= -6
    f2 = fbeta_score(hr, pred_r >= -6, beta=2)
    pc = np.where(pred_r < -6, -6.001, pred_r)
    mse = ((pc[hr] - true_r[hr]) ** 2).mean()
    return f2, mse, mse / f2

def tier_report(name, pred_t):
    crit_t, crit_p = (y_t == 2), (pred_t == 2)
    esc = y_t.values > last_t                          # events that escalate after cutoff
    print(f'{name:28s} acc={np.mean(pred_t==y_t):.3f} macroF1={f1_score(y_t,pred_t,average="macro"):.3f} '
          f'Crit P={precision_score(crit_t,crit_p):.3f} R={recall_score(crit_t,crit_p):.3f} '
          f'F2={fbeta_score(crit_t,crit_p,beta=2):.3f} | escalations caught {np.sum(esc & (pred_t>=y_t.values))}/{esc.sum()}')

last_t = tier(last.risk.values, last.miss_distance.values)
print('\n--- Kelvins metric (risk regression, threshold -6) ---')
for n, p in [('Latest risk (LRP)', last.risk.values), ('Constant -5 (CRP)', np.full(len(tgt), -5.0))]:
    f2, mse, L = kelvins(p, y_r.values); print(f'{n:28s} F2={f2:.3f} MSE_HR={mse:.3f} L={L:.3f}')

print('\n--- 3-tier task (your challenge tiers) ---')
tier_report('Persistence (last tier)', last_t)
tier_report('Always Safe', np.zeros(len(tgt), int))

# --- event-level features from CDMs >=2d ---
def feats(x):
    x = x.sort_values('time_to_tca', ascending=False); l = x.iloc[-1]
    t = x.time_to_tca.values; r = x.risk.values; md = x.miss_distance.values
    slope = lambda v: np.polyfit(-t, v, 1)[0] if len(x) > 1 else 0.0
    return pd.Series({
        'risk_last': l.risk, 'risk_max': r.max(), 'risk_mean': r.mean(), 'risk_slope': slope(r),
        'risk_delta': r[-1] - r[0], 'md_last': l.miss_distance, 'md_min': md.min(),
        'md_slope': slope(np.log10(md)), 'n_cdm': len(x), 't_last': l.time_to_tca,
        'speed': l.relative_speed, 'pos_r': l.relative_position_r, 'pos_t': l.relative_position_t,
        'pos_n': l.relative_position_n, 'c_sig_r': np.log10(l.c_sigma_r + 1e-9),
        't_sig_r': np.log10(l.t_sigma_r + 1e-9),
        'c_sig_shrink': np.log10(x.c_sigma_r.iloc[0] + 1e-9) - np.log10(l.c_sigma_r + 1e-9),
        'max_risk_est': l.max_risk_estimate, 'F10': l.F10, 'AP': l.AP,
        'debris': int(l.c_object_type == 'DEBRIS'), 'payload': int(l.c_object_type == 'PAYLOAD'),
        'tier_last': tier(np.array([l.risk]), np.array([l.miss_distance]))[0]})
X = inp.groupby('event_id').apply(feats).loc[tgt.index]

oof = np.zeros((len(X), 3))
skf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=0)
for tr, va in skf.split(X, y_t, groups=tgt.mission_id.values if False else X.index):
    m = lgb.LGBMClassifier(n_estimators=400, learning_rate=0.03, num_leaves=31,
                           class_weight='balanced', verbose=-1, random_state=0)
    m.fit(X.iloc[tr], y_t.iloc[tr]); oof[va] = m.predict_proba(X.iloc[va])
tier_report('LightGBM (5-fold OOF)', oof.argmax(1))
imp = pd.Series(m.feature_importances_, X.columns).sort_values(ascending=False)
print('\ntop features:', ', '.join(imp.index[:8]))
