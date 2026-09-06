import os
import pandas as pd, numpy as np, json

# Portable paths: this script lives in <repo>/src/, data lives in <repo>/data/,
# intermediates in <repo>/build/, final payload goes to <repo>/app/payload.json
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, 'data')
BUILD_DIR = os.path.join(ROOT, 'build')
APP_DIR = os.path.join(ROOT, 'app')

area = pd.read_csv(os.path.join(BUILD_DIR, 'area_curves.csv'))
glob = pd.read_csv(os.path.join(BUILD_DIR, 'global_curves.csv'))
pop_ref = pd.read_csv(os.path.join(DATA_DIR, 'population-reference.csv'))

#crimes = sorted(area['crime'].unique())
crimes = ['homicide', 'causing_death_or_serious_injury_unlawful_driving',  'most_serious_violence', 'wounding', 'wounding_serious', 
          'wounding_less_serious','common_assault',
          'firearms_offences',
          'rape_and_sexual_assault', 'rape', 'sexual_assault', 
          'robbery', 'robbery_business', 'robbery_personal', 
          'burglary', 'burglary_other', 'burglary_residential',
          'vehicle_offences', 'veh_theft_of_mv', 'veh_theft_from_mv',
          'theft_person_and_other_theft', 'other_theft', 'theft_person',
          'shoplifting',
          'drug_trafficking']
crime_idx = {c:i for i,c in enumerate(crimes)}

# area list: CSP areas keep pfa_name(parent); PFA areas are their own parent
areas_meta = area[['area_type','area','pfa_name']].drop_duplicates().reset_index(drop=True)
areas_meta = areas_meta.sort_values(['area_type','area']).reset_index(drop=True)
area_idx = {}
area_list = []
for i,row in areas_meta.iterrows():
    area_idx[(row['area_type'], row['area'])] = i
    area_list.append({'n': row['area'], 't': row['area_type'], 'p': row['pfa_name']})

print('n crimes', len(crimes), 'n areas', len(area_list))

def r(x, nd):
    return round(float(x), nd)

# Table1: nested crime_idx -> area_idx -> {c:[44 int], d:[44 f3], s:[44 f3]}
series = {ci: {} for ci in range(len(crimes))}
# Table2: season dev per (crime, area, quarter)
season = {ci: {} for ci in range(len(crimes))}
# Table3: intercept per crime, area
intercept = {ci: {} for ci in range(len(crimes))}

area.sort_values(['crime','area_type','area','t'], inplace=True)
grouped = area.groupby(['crime','area_type','area'])
for (crime, atype, aname), g in grouped:
    ci = crime_idx[crime]
    ai = area_idx[(atype, aname)]
    g = g.sort_values('t')
    counts = g['count'].astype(int).tolist()
    tdev = [r(x,3) for x in g['trend_dev']]
    tdse = [r(x,3) for x in g['trend_dev_se']]
    series[ci][ai] = [counts, tdev, tdse]
    # season: take unique per quarter (first occurrence per quarter)
    sq = g.drop_duplicates('quarter')[['quarter','season_dev','season_dev_se']]
    sdict = {int(row['quarter']): [r(row['season_dev'],3), r(row['season_dev_se'],3)] for _,row in sq.iterrows()}
    season[ci][ai] = [sdict.get(q,[0,0]) for q in [1,2,3,4]]
    # intercept: constant, take mean (should be identical for all rows of same area-crime, but avg for safety)
    intercept[ci][ai] = r(g['e'].iloc[0]*0 + (g['observed_rate'].iloc[0]*0), 3)  # placeholder, replaced below

# recompute intercept properly: area_intercept = mean(logit_p) - mean(trend_season at own t's); but we didn't save it directly.
# Instead reconstruct from area_fitted relationship: fitted_rate provided as check; let's recompute intercept via stored columns we DO have:
# fitted_logit = global_trend[t]+global_season[q]+area_intercept+trend_dev[t]+season_dev[q]
# We have fitted_rate -> fitted_logit = logit(fitted_rate/400000). Solve for area_intercept using t=0 row.
# CSP areas were fit against the CSP-scope global; PFA areas against the PFA-scope global -- use the matching one.
glob_by_crime_scope = {
    (c, scope): glob[(glob.crime == c) & (glob.scope == scope)].sort_values('t').reset_index(drop=True)
    for c in crimes for scope in ['CSP', 'PFA']
}

def logit(p): return np.log(p/(1-p))

area_first = area.drop_duplicates(['crime','area_type','area'], keep='first')
for _, row in area_first.iterrows():
    crime = row['crime']; ci = crime_idx[crime]
    atype = row['area_type']
    ai = area_idx[(atype, row['area'])]
    t0 = int(row['t']); q0 = int(row['quarter'])
    gscope = glob_by_crime_scope[(crime, atype)]
    gtrend = gscope.loc[t0,'trend']
    # global season deviation at q0 relative: derive from trend_season - trend at same t
    gseason = gscope.loc[t0,'trend_season'] - gtrend
    fitted_logit = logit(row['fitted_rate']/400000.0)
    tdev0 = r(row['trend_dev'],3)
    sdev0 = r(row['season_dev'],3)
    area_intercept = fitted_logit - gtrend - gseason - tdev0 - sdev0
    intercept[ci][ai] = r(area_intercept, 3)

# population lookup: area_type, area_name -> {year: population}
pop_ref2 = pop_ref.rename(columns={'AreaType':'area_type','CSP':'csp','PFA':'pfa','Year':'year','Population':'population'})
pop_lookup = {}
for _, row in pop_ref2.iterrows():
    if row['area_type']=='CSP':
        key = ('CSP', row['csp'])
    else:
        key = ('PFA', row['pfa'])
    if key not in area_idx:
        continue
    ai = area_idx[key]
    pop_lookup.setdefault(ai, {})[int(row['year'])] = int(row['population'])

# global curves compact, kept separate per scope: crime -> [trend[44], trend_season[44], shared[44]]
global_compact_csp = {}
global_compact_pfa = {}
for c in crimes:
    for scope, store in [('CSP', global_compact_csp), ('PFA', global_compact_pfa)]:
        gg = glob_by_crime_scope[(c, scope)]
        store[crime_idx[c]] = [
            [r(x,3) for x in gg['trend']],
            [r(x,3) for x in gg['trend_season']],
            [r(x,3) for x in gg['shared_time_effect']],
        ]

# period metadata: t -> {fy, quarter, period_start}
periods = area[['t','quarter']].drop_duplicates().sort_values('t')
# need fy and period_start too - get from original raw crime-reference via t mapping (recompute)
raw = pd.read_csv(os.path.join(DATA_DIR, 'crime-reference.csv'))
raw['period_start'] = pd.to_datetime(raw['period_start'])
uniq_periods = sorted(raw['period_start'].unique())
period_meta = []
for i,p in enumerate(uniq_periods):
    row = raw[raw['period_start']==p].iloc[0]
    period_meta.append({'fy': row['fy'], 'q': int(row['quarter']), 'ds': str(pd.Timestamp(p).date())})

payload = {
    'crimes': crimes,
    'areas': area_list,
    'periods': period_meta,
    'series': series,
    'season': season,
    'intercept': intercept,
    'pop': pop_lookup,
    'global_csp': global_compact_csp,
    'global_pfa': global_compact_pfa,
}

payload_path = os.path.join(APP_DIR, 'payload.json')
with open(payload_path, 'w') as f:
    json.dump(payload, f, separators=(',', ':'))

print('payload size MB', os.path.getsize(payload_path) / 1e6)
