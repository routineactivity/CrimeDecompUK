import os
import numpy as np, pandas as pd, json, warnings
import statsmodels.formula.api as smf
warnings.filterwarnings("ignore")

# Portable paths: this script lives in <repo>/src/, data lives in <repo>/data/,
# intermediate outputs go to <repo>/build/
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, 'data')
BUILD_DIR = os.path.join(ROOT, 'build')
os.makedirs(BUILD_DIR, exist_ok=True)

RAW = pd.read_csv(os.path.join(DATA_DIR, 'crime-reference.csv'))
RAW['period_start'] = pd.to_datetime(RAW['period_start'])

CRIME_COLS = [c for c in RAW.columns if c not in
    ['area_type','pfa_code','pfa_name','csp_name','lad_codes','fy','quarter','period_start','population']]

# build a stable time index t = 0..43 from sorted unique period_start
periods = sorted(RAW['period_start'].unique())
t_of_period = {p:i for i,p in enumerate(periods)}
RAW['t'] = RAW['period_start'].map(t_of_period)
NT = len(periods)
print("n periods", NT, "n crime cols", len(CRIME_COLS))

csp = RAW[RAW.area_type=='CSP'].copy()
pfa = RAW[RAW.area_type=='PFA'].copy()

def logit(p):
    return np.log(p/(1-p))
def inv_logit(x):
    return 1/(1+np.exp(-x))

def prep(df, crime):
    d = df[['t','quarter','population',crime]].copy()
    d = d.rename(columns={crime:'count'})
    d['count_clip'] = d['count'].clip(lower=0)  # negative counts are HO revision/transfer artifacts; clip for rate calc only
    d['p'] = (d['count_clip']+0.5)/(d['population']+1.0)
    d['logit_p'] = logit(d['p'])
    return d

def fit_global(df_scope, crime):
    """Fits the national (population-weighted) trend + quarter-effect model
    for one scope ('CSP' rows or 'PFA' rows), entirely separately -- CSP and
    PFA global curves never share data with each other."""
    gd = prep(df_scope, crime)
    gmod = smf.wls('logit_p ~ cr(t, df=6) + C(quarter)', data=gd, weights=gd['population']).fit()

    grid = pd.DataFrame({'t': np.arange(NT), 'quarter': 1})
    trend_pred = gmod.get_prediction(grid).summary_frame()['mean'].values  # quarter fixed at 1 -> trend alone

    grid_q = pd.DataFrame({'t': np.arange(NT), 'quarter': [(i % 4) + 1 for i in range(NT)]})
    trend_season_pred = gmod.get_prediction(grid_q).summary_frame()['mean'].values

    season_by_q = {1: 0.0}
    for qv in [2, 3, 4]:
        season_by_q[qv] = gmod.params.get(f"C(quarter)[T.{qv}]", 0.0)

    gd2 = gd.copy()
    gd2['fitted'] = gmod.predict(gd2)
    gd2['resid'] = gd2['logit_p'] - gd2['fitted']
    shared = gd2.groupby('t').apply(lambda x: np.average(x['resid'], weights=x['population'])).reindex(range(NT)).fillna(0.0).values

    trend_mean = trend_pred.mean()
    season_vals = np.array([season_by_q[1], season_by_q[2], season_by_q[3], season_by_q[4]])
    season_mean = season_vals.mean()

    return {
        'trend': trend_pred, 'trend_season': trend_season_pred, 'shared': shared,
        'season_by_q': season_by_q, 'trend_mean': trend_mean, 'season_mean': season_mean,
    }

global_rows = []
area_rows = []

for crime in CRIME_COLS:
    print("crime:", crime)
    g_csp = fit_global(csp, crime)
    g_pfa = fit_global(pfa, crime)
    globals_by_scope = {'CSP': g_csp, 'PFA': g_pfa}

    for scope, g in globals_by_scope.items():
        for i in range(NT):
            global_rows.append({
                'crime': crime, 'scope': scope, 't': i, 'trend': g['trend'][i],
                'trend_season': g['trend_season'][i], 'shared_time_effect': g['shared'][i]
            })

    # ---- area level: CSP areas compare against the CSP-fit global; PFA areas against the PFA-fit global ----
    for area_type, df_area, id_col in [('CSP', csp, 'csp_name'), ('PFA', pfa, 'pfa_name')]:
        g = globals_by_scope[area_type]
        trend_pred, trend_season_pred, shared = g['trend'], g['trend_season'], g['shared']
        season_by_q, trend_mean, season_mean = g['season_by_q'], g['trend_mean'], g['season_mean']

        cols = [id_col,'t','quarter','population',crime] if id_col=='pfa_name' else [id_col,'pfa_name','t','quarter','population',crime]
        sub_all = df_area[cols].rename(columns={crime:'count'})
        for area_id, gg in sub_all.groupby(id_col):
            gg = gg.sort_values('t').copy()
            if len(gg) < NT:
                continue
            gg['count_clip'] = gg['count'].clip(lower=0)
            gg['p'] = (gg['count_clip']+0.5)/(gg['population']+1.0)
            gg['logit_p'] = logit(gg['p'])
            try:
                amod = smf.ols('logit_p ~ cr(t, df=3) + C(quarter)', data=gg).fit()
            except Exception:
                continue
            agrid = pd.DataFrame({'t': gg['t'].values, 'quarter': 1})
            aframe = amod.get_prediction(agrid).summary_frame()
            area_trend = aframe['mean'].values
            area_trend_se = aframe['mean_se'].values

            area_season_by_q = {1: 0.0}
            area_season_se_by_q = {1: 0.0}
            bse = amod.bse
            for qv in [2, 3, 4]:
                key = f"C(quarter)[T.{qv}]"
                area_season_by_q[qv] = amod.params.get(key, 0.0)
                area_season_se_by_q[qv] = bse.get(key, 0.0)

            a_season_vals = np.array([area_season_by_q[1], area_season_by_q[2], area_season_by_q[3], area_season_by_q[4]])
            a_season_mean = a_season_vals.mean()

            trend_dev = (area_trend - area_trend.mean()) - (trend_pred - trend_mean)
            season_dev_by_q = {qv: (area_season_by_q[qv]-a_season_mean) - (season_by_q[qv]-season_mean) for qv in [1,2,3,4]}

            area_intercept = gg['logit_p'].mean() - trend_season_pred[gg['t'].values].mean()

            qvals = gg['quarter'].values
            season_dev_series = np.array([season_dev_by_q[qv] for qv in qvals])
            season_series = np.array([season_by_q[qv] for qv in qvals])
            tvals = gg['t'].values

            area_fitted = trend_pred[tvals] + season_series + area_intercept + trend_dev + season_dev_series
            expected = area_fitted + shared[tvals]
            e = gg['logit_p'].values - expected
            se_e = np.sqrt(1.0/(gg['count_clip'].values+0.5) + 1.0/(gg['population'].values-gg['count_clip'].values+0.5))

            se_dev_series = np.array([area_season_se_by_q[qv] for qv in qvals])
            trend_dev_se = area_trend_se  # approx

            observed_rate = 4*100000*(gg['count_clip'].values/gg['population'].values)
            expected_rate = 4*100000*inv_logit(expected)
            fitted_rate = 4*100000*inv_logit(area_fitted)

            pfa_name_val = gg['pfa_name'].iloc[0]
            for k in range(len(gg)):
                area_rows.append({
                    'crime': crime, 'area_type': area_type, 'area': area_id, 'pfa_name': pfa_name_val,
                    't': int(tvals[k]), 'quarter': int(qvals[k]),
                    'count': int(gg['count'].values[k]), 'population': float(gg['population'].values[k]),
                    'observed_rate': observed_rate[k], 'expected_rate': expected_rate[k], 'fitted_rate': fitted_rate[k],
                    'trend_dev': trend_dev[k], 'trend_dev_se': trend_dev_se[k],
                    'season_dev': season_dev_series[k], 'season_dev_se': se_dev_series[k],
                    'e': e[k], 'se_e': se_e[k]
                })

gdf = pd.DataFrame(global_rows)
adf = pd.DataFrame(area_rows)
gdf.to_csv(os.path.join(BUILD_DIR, 'global_curves.csv'), index=False)
adf.to_csv(os.path.join(BUILD_DIR, 'area_curves.csv'), index=False)
print("global rows", len(gdf), "area rows", len(adf))
print(gdf.head())
print(adf.head())
