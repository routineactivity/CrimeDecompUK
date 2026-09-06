(() => {
  const periods = DATA.periods, NT = periods.length;
  const crimes = DATA.crimes, areas = DATA.areas;
  const $ = id => document.getElementById(id);
  const esc = x => String(x).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const fmt = x => Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : "-";
  const fmt1 = x => Number.isFinite(x) ? x.toFixed(1) : "-";
  const crimeLabel = c => c.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  const invlogit = x => 1 / (1 + Math.exp(-x));
  const logit = p => Math.log(p / (1 - p));
  const RATE_MULT = 400000; // 4 quarters x 100,000

  const state = { crime: crimes.indexOf('most_serious_violence') >= 0 ? crimes.indexOf('most_serious_violence') : 0, pfa: '', csp: '', pfaOnly: '' };

  // ---------- data accessors ----------
  function popOf(ai, t) {
    const year = parseInt(periods[t].fy.slice(0, 4), 10);
    const rec = DATA.pop[ai];
    if (!rec) return NaN;
    return rec[year] ?? rec[String(year)];
  }
  function getSeries(ci, ai) { const c = DATA.series[ci]; return c ? c[ai] : undefined; }
  function getSeason(ci, ai) { const c = DATA.season[ci]; return c ? c[ai] : undefined; }
  function getIntercept(ci, ai) { const c = DATA.intercept[ci]; return c ? c[ai] : undefined; }
  function getGlobal(ci, scope) { return scope === 'PFA' ? DATA.global_pfa[ci] : DATA.global_csp[ci]; }

  function nationalSeasonByQuarter(ci, scope) {
    const [gtrend, gtrend_season] = getGlobal(ci, scope);
    const byQ = {};
    for (let t = 0; t < NT; t++) {
      const q = periods[t].q;
      if (!(q in byQ)) byQ[q] = gtrend_season[t] - gtrend[t];
    }
    return [1, 2, 3, 4].map(q => byQ[q]);
  }

  function computeAreaCurve(ci, ai) {
    const series = getSeries(ci, ai);
    if (!series) return null;
    const [counts, tdev, tdse] = series;
    const season = getSeason(ci, ai);
    const intercept = getIntercept(ci, ai);
    const scope = areas[ai].t; // 'CSP' or 'PFA' -- each compares against its own scope's national model
    const [gtrend, gtrend_season, gshared] = getGlobal(ci, scope);
    const out = { count: [], population: [], observed_rate: [], fitted_rate: [], expected_rate: [],
      fitted_logit: [], trend_dev: tdev, trend_dev_se: tdse, season_dev: [], season_dev_se: [], e: [], se_e: [] };
    for (let t = 0; t < NT; t++) {
      const q = periods[t].q;
      const gseason_t = gtrend_season[t] - gtrend[t];
      const [sdev, sse] = season[q - 1];
      const fitted_logit = gtrend[t] + gseason_t + intercept + tdev[t] + sdev;
      const expected_logit = fitted_logit + gshared[t];
      const pop = popOf(ai, t);
      const cnt = counts[t];
      const cntClip = Math.max(cnt, 0);
      const p = (cntClip + 0.5) / (pop + 1);
      const observed_logit = logit(p);
      const e = observed_logit - expected_logit;
      const se_e = Math.sqrt(1 / (cntClip + 0.5) + 1 / (pop - cntClip + 0.5));
      out.count.push(cnt);
      out.population.push(pop);
      out.observed_rate.push(RATE_MULT * p);
      out.fitted_rate.push(RATE_MULT * invlogit(fitted_logit));
      out.expected_rate.push(RATE_MULT * invlogit(expected_logit));
      out.fitted_logit.push(fitted_logit);
      out.season_dev.push(sdev);
      out.season_dev_se.push(sse);
      out.e.push(e);
      out.se_e.push(se_e);
    }
    return out;
  }

  function cspAreaIndices() { return areas.map((a, i) => i).filter(i => areas[i].t === 'CSP'); }
  function pfaAreaIndices() { return areas.map((a, i) => i).filter(i => areas[i].t === 'PFA'); }

  const globalAggCache = new Map();
  function computeGlobalAggregates(ci) {
    if (globalAggCache.has(ci)) return globalAggCache.get(ci);
    const sumCount = new Array(NT).fill(0), sumPop = new Array(NT).fill(0), sumFittedW = new Array(NT).fill(0);
    for (const ai of cspAreaIndices()) {
      const curve = computeAreaCurve(ci, ai);
      if (!curve) continue;
      for (let t = 0; t < NT; t++) {
        const cnt = Math.max(curve.count[t], 0), pop = curve.population[t];
        if (!Number.isFinite(pop)) continue;
        sumCount[t] += cnt; sumPop[t] += pop;
        sumFittedW[t] += pop * invlogit(curve.fitted_logit[t]);
      }
    }
    const observed = sumCount.map((c, t) => RATE_MULT * c / sumPop[t]);
    const sampleFitted = sumFittedW.map((s, t) => RATE_MULT * s / sumPop[t]);
    const result = { observed, sampleFitted };
    globalAggCache.set(ci, result);
    return result;
  }

  // ---------- SVG drawing helpers ----------
  const MAIN_H = 330, SHORT_H = 220, ALL_H = 260;
  const PLOT_L = 66, PLOT_R = 1010, PLOT_TOP = 38, PLOT_BOTTOM_OFFSET = 40;
  const xScaleT = t => PLOT_L + t * (PLOT_R - PLOT_L) / (NT - 1);
  const xScaleQ = q => PLOT_L + (q - 1) * (PLOT_R - PLOT_L) / 3;
  const yScale = (v, ymin, ymax, H) => PLOT_TOP + (ymax - v) * (H - PLOT_BOTTOM_OFFSET - PLOT_TOP) / ((ymax - ymin) || 1);

  function pathFrom(values, xScaleFn, ymin, ymax, H) {
    let d = '';
    values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) return;
      d += (d ? 'L' : 'M') + xScaleFn(i).toFixed(1) + ',' + yScale(v, ymin, ymax, H).toFixed(1) + ' ';
    });
    return d.trim();
  }
  function ribbonPath(lower, upper, xScaleFn, ymin, ymax, H) {
    let up = '', down = '';
    upper.forEach((v, i) => { up += (up ? 'L' : 'M') + xScaleFn(i).toFixed(1) + ',' + yScale(v, ymin, ymax, H).toFixed(1) + ' '; });
    for (let i = lower.length - 1; i >= 0; i--) down += 'L' + xScaleFn(i).toFixed(1) + ',' + yScale(lower[i], ymin, ymax, H).toFixed(1) + ' ';
    return (up + down + 'Z').trim();
  }

  function axisBase(title, ymin, ymax, ylabel, H, xTicksFn) {
    let s = `<svg viewBox="0 0 1060 ${H}" role="img" aria-label="${esc(title)}"><text x="66" y="22" class="chart-title">${esc(title)}</text>`;
    [0, .25, .5, .75, 1].forEach(f => {
      const y = PLOT_TOP + f * (H - PLOT_BOTTOM_OFFSET - PLOT_TOP), v = ymax - f * (ymax - ymin);
      s += `<line x1="66" x2="1010" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="grid"/><text x="58" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis-label">${fmt(v)}</text>`;
    });
    if (ymin < 0 && ymax > 0) {
      const zy = yScale(0, ymin, ymax, H);
      s += `<line x1="66" x2="1010" y1="${zy.toFixed(1)}" y2="${zy.toFixed(1)}" class="zero-line"/>`;
    }
    s += `<line x1="66" x2="1010" y1="${H - PLOT_BOTTOM_OFFSET}" y2="${H - PLOT_BOTTOM_OFFSET}" class="axis"/><text x="17" y="${(H / 2).toFixed(1)}" transform="rotate(-90 17 ${(H / 2).toFixed(1)})" text-anchor="middle" class="axis-label">${esc(ylabel)}</text>`;
    s += xTicksFn(H);
    s += '</svg>';
    return s;
  }
  function timeTicks(H) {
    let s = '';
    for (let t = 0; t < NT; t++) {
      if (periods[t].q === 1) {
        const x = xScaleT(t);
        s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${H - PLOT_BOTTOM_OFFSET}" y2="${H - PLOT_BOTTOM_OFFSET + 6}" class="x-tick"/><text x="${x.toFixed(1)}" y="${H - 14}" text-anchor="middle" class="axis-label">${periods[t].fy.split('/')[0]}</text>`;
      }
    }
    return s;
  }
  function quarterTicks(H) {
    let s = '';
    ['Q1', 'Q2', 'Q3', 'Q4'].forEach((lab, i) => {
      const x = xScaleQ(i + 1);
      s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${H - PLOT_BOTTOM_OFFSET}" y2="${H - PLOT_BOTTOM_OFFSET + 6}" class="x-tick"/><text x="${x.toFixed(1)}" y="${H - 14}" text-anchor="middle" class="axis-label">${lab}</text>`;
    });
    return s;
  }

  function chartWrap(svgInner, extraPaths, legendItems) {
    const idx = svgInner.lastIndexOf('</svg>');
    const withPaths = svgInner.slice(0, idx) + extraPaths + svgInner.slice(idx);
    const legend = legendItems ? `<div class="legend">${legendItems.map(l => `<span><span class="swatch" style="background:${l.c}"></span>${esc(l.label)}</span>`).join('')}</div>` : '';
    return withPaths + legend;
  }

  function rangeOf(arrays) {
    let ymin = Infinity, ymax = -Infinity;
    arrays.forEach(a => a.forEach(v => { if (Number.isFinite(v)) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; } }));
    if (!Number.isFinite(ymin)) { ymin = 0; ymax = 1; }
    const pad = (ymax - ymin) * 0.1 || (Math.abs(ymax) * 0.1) || 1;
    return [ymin - pad, ymax + pad];
  }

  // ---------- populate selectors ----------
  const crimeSelect = $('crime');
  crimes.forEach((c, i) => { const o = document.createElement('option'); o.value = i; o.textContent = crimeLabel(c); crimeSelect.appendChild(o); });
  crimeSelect.value = state.crime;

  const pfaNames = Array.from(new Set(areas.filter(a => a.t === 'CSP').map(a => a.p))).sort();
  function fillPfaSelect(sel, includeAll) {
    sel.innerHTML = '';
    pfaNames.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); });
  }
  fillPfaSelect($('csp-pfa-select'));
  function fillCspSelect(pfaName) {
    const sel = $('csp-select'); sel.innerHTML = '';
    areas.map((a, i) => ({ a, i })).filter(x => x.a.t === 'CSP' && x.a.p === pfaName)
      .sort((x, y) => x.a.n.localeCompare(y.a.n))
      .forEach(x => { const o = document.createElement('option'); o.value = x.i; o.textContent = x.a.n; sel.appendChild(o); });
  }
  $('csp-pfa-select').addEventListener('change', e => { fillCspSelect(e.target.value); renderCsp(); });
  fillCspSelect(pfaNames[0]);
  $('csp-pfa-select').value = pfaNames[0];

  const pfaAreaSel = $('pfa-select');
  areas.map((a, i) => ({ a, i })).filter(x => x.a.t === 'PFA').sort((x, y) => x.a.n.localeCompare(y.a.n))
    .forEach(x => { const o = document.createElement('option'); o.value = x.i; o.textContent = x.a.n; pfaAreaSel.appendChild(o); });

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.page).classList.add('active');
    renderAll();
  }));
  crimeSelect.addEventListener('change', () => { state.crime = parseInt(crimeSelect.value, 10); renderAll(); });
  $('csp-select').addEventListener('change', renderCsp);
  pfaAreaSel.addEventListener('change', renderPfa);

  // ---------- Global page ----------
  function renderGlobal() {
    const ci = state.crime;
    const [gtrend, gtrend_season, gshared] = getGlobal(ci, 'CSP');
    const { observed, sampleFitted } = computeGlobalAggregates(ci);
    const trendRate = gtrend.map(v => RATE_MULT * invlogit(v));
    const trendSeasonRate = gtrend_season.map(v => RATE_MULT * invlogit(v));
    const [ymin, ymax] = rangeOf([observed, sampleFitted, trendRate, trendSeasonRate]);
    let s = axisBase('Annualised rate per 100,000 residents', Math.max(ymin, 0), ymax, 'Rate per 100k', MAIN_H, timeTicks);
    let paths = '';
    paths += `<path d="${pathFrom(observed, xScaleT, Math.max(ymin, 0), ymax, MAIN_H)}" fill="none" stroke="var(--ink)" stroke-width="1.5" opacity="0.5"/>`;
    paths += `<path d="${pathFrom(sampleFitted, xScaleT, Math.max(ymin, 0), ymax, MAIN_H)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    paths += `<path d="${pathFrom(trendRate, xScaleT, Math.max(ymin, 0), ymax, MAIN_H)}" fill="none" stroke="var(--accent2)" stroke-width="1.3" stroke-dasharray="5 3"/>`;
    paths += `<path d="${pathFrom(trendSeasonRate, xScaleT, Math.max(ymin, 0), ymax, MAIN_H)}" fill="none" stroke="var(--accent2)" stroke-width="2.2"/>`;
    $('global-chart').innerHTML = chartWrap(s, paths, [
      { c: 'var(--ink)', label: 'Observed (population-weighted)' },
      { c: 'var(--accent)', label: 'Sample fitted' },
      { c: 'var(--accent2)', label: 'Global trend' },
      { c: 'var(--accent2)', label: 'Global trend + season' }
    ]);

    // seasonal component: logit-scale season deviation by quarter
    const seasonByQ = nationalSeasonByQuarter(ci, 'CSP');
    const seasonCentered = seasonByQ.map(v => v - seasonByQ.reduce((a, b) => a + b, 0) / 4);
    const [sy0, sy1] = rangeOf([seasonCentered]);
    let s2 = axisBase('Seasonal effect (logit scale)', sy0, sy1, 'Logit deviation', SHORT_H, quarterTicks);
    let p2 = `<path d="${pathFrom(seasonCentered, xScaleQ ? (i => xScaleQ(i + 1)) : null, sy0, sy1, SHORT_H)}" fill="none" stroke="var(--accent2)" stroke-width="2.2"/>`;
    seasonCentered.forEach((v, i) => { p2 += `<circle cx="${xScaleQ(i + 1).toFixed(1)}" cy="${yScale(v, sy0, sy1, SHORT_H).toFixed(1)}" r="3" fill="var(--accent2)"/>`; });
    $('seasonal-chart').innerHTML = s2.replace('</svg>', p2 + '</svg>');

    // shared time-period effect
    const [ry0, ry1] = rangeOf([gshared]);
    let s3 = axisBase('Shared time-period effect (logit scale)', ry0, ry1, 'Logit deviation', SHORT_H, timeTicks);
    let p3 = `<path d="${pathFrom(gshared, xScaleT, ry0, ry1, SHORT_H)}" fill="none" stroke="var(--accent)" stroke-width="1.8"/>`;
    $('global-residual-chart').innerHTML = s3.replace('</svg>', p3 + '</svg>');

    $('status').textContent = `${areas.filter(a => a.t === 'CSP').length} Community Safety Partnerships \u00b7 ${areas.filter(a => a.t === 'PFA').length} Police Force Areas \u00b7 ${crimeLabel(crimes[ci])} \u00b7 ${NT} quarters loaded`;
  }

  // ---------- Area detail (shared by CSP + PFA pages) ----------
  function renderAreaDetail(prefix, ai, label) {
    const ci = state.crime;
    const scope = areas[ai].t; // matches the area's own type: CSP page -> CSP global, PFA page -> PFA global
    const curve = computeAreaCurve(ci, ai);
    if (!curve) { $(`${prefix}-chart`).innerHTML = '<p class="caption">No data for this selection.</p>'; return; }
    const [gtrend, gtrend_season, gshared] = getGlobal(ci, scope);
    const globalBaselineRate = gtrend_season.map(v => RATE_MULT * invlogit(v));

    $(`${prefix}-title`).textContent = `${label}: ${crimeLabel(crimes[ci])}`;
    $(`${prefix}-trend-title`).textContent = `${label} and national trends`;
    $(`${prefix}-season-title`).textContent = `${label} and national seasonal patterns`;
    $(`${prefix}-residual-title`).textContent = `${label} and national residuals`;

    // chart 1: observed vs global baseline vs area fitted (rate scale)
    const [y0, y1] = rangeOf([curve.observed_rate, curve.fitted_rate, globalBaselineRate]);
    let s1 = axisBase('Annualised rate per 100,000', Math.max(y0, 0), y1, 'Rate per 100k', MAIN_H, timeTicks);
    let p1 = '';
    p1 += `<path d="${pathFrom(curve.observed_rate, xScaleT, Math.max(y0, 0), y1, MAIN_H)}" fill="none" stroke="var(--ink)" stroke-width="1.6" opacity="0.6"/>`;
    p1 += `<path d="${pathFrom(globalBaselineRate, xScaleT, Math.max(y0, 0), y1, MAIN_H)}" fill="none" stroke="var(--accent2)" stroke-width="1.6" stroke-dasharray="5 3"/>`;
    p1 += `<path d="${pathFrom(curve.fitted_rate, xScaleT, Math.max(y0, 0), y1, MAIN_H)}" fill="none" stroke="var(--accent)" stroke-width="2.2"/>`;
    $(`${prefix}-chart`).innerHTML = chartWrap(s1, p1, [
      { c: 'var(--ink)', label: 'Observed' },
      { c: 'var(--accent2)', label: 'Global baseline (trend+season)' },
      { c: 'var(--accent)', label: `${label} fitted` }
    ]);

    // chart 2: trend comparison (logit scale), centered
    const gtrendCentered = gtrend.map(v => v - gtrend.reduce((a, b) => a + b, 0) / NT);
    const areaTrendCentered = curve.trend_dev.map((d, i) => d + gtrendCentered[i]);
    const upperT = areaTrendCentered.map((v, i) => v + 1.96 * curve.trend_dev_se[i]);
    const lowerT = areaTrendCentered.map((v, i) => v - 1.96 * curve.trend_dev_se[i]);
    const [ty0, ty1] = rangeOf([gtrendCentered, upperT, lowerT]);
    let s2 = axisBase('Centered trend (logit scale)', ty0, ty1, 'Logit deviation', SHORT_H, timeTicks);
    let p2 = `<path d="${ribbonPath(lowerT, upperT, xScaleT, ty0, ty1, SHORT_H)}" class="interval-band"/>`;
    p2 += `<path d="${pathFrom(gtrendCentered, xScaleT, ty0, ty1, SHORT_H)}" fill="none" stroke="var(--accent2)" stroke-width="1.6" stroke-dasharray="5 3"/>`;
    p2 += `<path d="${pathFrom(areaTrendCentered, xScaleT, ty0, ty1, SHORT_H)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    $(`${prefix}-trend-chart`).innerHTML = chartWrap(s2, p2, [{ c: 'var(--accent2)', label: 'National' }, { c: 'var(--accent)', label: label }]);

    // chart 3: season comparison (logit scale, quarter axis)
    const natSeasonQ = nationalSeasonByQuarter(ci, scope);
    const natSeasonCentered = natSeasonQ.map(v => v - natSeasonQ.reduce((a, b) => a + b, 0) / 4);
    const areaSeasonQ = getSeason(ci, ai).map((s, i) => s[0] + natSeasonCentered[i]);
    const areaSeasonSe = getSeason(ci, ai).map(s => s[1]);
    const upperS = areaSeasonQ.map((v, i) => v + 1.96 * areaSeasonSe[i]);
    const lowerS = areaSeasonQ.map((v, i) => v - 1.96 * areaSeasonSe[i]);
    const [sy0, sy1] = rangeOf([natSeasonCentered, upperS, lowerS]);
    let s3 = axisBase('Centered season (logit scale)', sy0, sy1, 'Logit deviation', SHORT_H, quarterTicks);
    const qx = i => xScaleQ(i + 1);
    let p3 = `<path d="${ribbonPath(lowerS, upperS, qx, sy0, sy1, SHORT_H)}" class="interval-band"/>`;
    p3 += `<path d="${pathFrom(natSeasonCentered, qx, sy0, sy1, SHORT_H)}" fill="none" stroke="var(--accent2)" stroke-width="1.6" stroke-dasharray="5 3"/>`;
    p3 += `<path d="${pathFrom(areaSeasonQ, qx, sy0, sy1, SHORT_H)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    $(`${prefix}-season-chart`).innerHTML = chartWrap(s3, p3, [{ c: 'var(--accent2)', label: 'National' }, { c: 'var(--accent)', label: label }]);

    // chart 4: residual comparison (logit scale)
    const upperE = curve.e.map((v, i) => v + 1.96 * curve.se_e[i]);
    const lowerE = curve.e.map((v, i) => v - 1.96 * curve.se_e[i]);
    const [ey0, ey1] = rangeOf([gshared, upperE, lowerE]);
    let s4 = axisBase('Residual (logit scale)', ey0, ey1, 'Logit deviation', SHORT_H, timeTicks);
    let p4 = `<path d="${ribbonPath(lowerE, upperE, xScaleT, ey0, ey1, SHORT_H)}" class="interval-band"/>`;
    p4 += `<path d="${pathFrom(gshared, xScaleT, ey0, ey1, SHORT_H)}" fill="none" stroke="var(--accent2)" stroke-width="1.6" stroke-dasharray="5 3"/>`;
    p4 += `<path d="${pathFrom(curve.e, xScaleT, ey0, ey1, SHORT_H)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    $(`${prefix}-residual-chart`).innerHTML = chartWrap(s4, p4, [{ c: 'var(--accent2)', label: 'National (shared quarter effect)' }, { c: 'var(--accent)', label: label }]);

    // table
    let rows = '';
    for (let t = 0; t < NT; t++) {
      const p = periods[t];
      const expCount = curve.expected_rate[t] * curve.population[t] / RATE_MULT;
      const flag = Math.abs(curve.e[t]) > 2 * curve.se_e[t] ? (curve.e[t] > 0 ? ' flag-up' : ' flag-down') : '';
      rows += `<tr class="${flag.trim()}"><td>${esc(p.fy)} Q${p.q}</td><td>${fmt1(expCount)}</td><td>${Math.round(curve.count[t]).toLocaleString()}</td><td>${fmt1(curve.expected_rate[t])}</td><td>${fmt1(curve.observed_rate[t])}</td><td>${fmt(curve.e[t])}</td><td>${fmt(curve.se_e[t])}</td></tr>`;
    }
    $(`${prefix}-quarter-table`).innerHTML = `<table class="data-table"><thead><tr><th>Quarter</th><th>Expected count</th><th>Observed count</th><th>Expected rate</th><th>Observed rate</th><th><em>e</em></th><th>SE(<em>e</em>)</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderCsp() {
    const ai = parseInt($('csp-select').value, 10);
    if (Number.isNaN(ai)) return;
    renderAreaDetail('csp', ai, areas[ai].n);
  }
  function renderPfa() {
    const ai = parseInt(pfaAreaSel.value, 10);
    if (Number.isNaN(ai)) return;
    renderAreaDetail('pfa', ai, areas[ai].n);
  }

  // ---------- All-CSP curves ----------
  const tooltip = $('chart-tooltip');
  function bindHover(container) {
    container.querySelectorAll('.city-curve').forEach(path => {
      path.addEventListener('mouseenter', () => {
        path.ownerSVGElement.classList.add('has-highlight');
        path.classList.add('highlighted');
        tooltip.textContent = path.dataset.label;
        tooltip.style.display = 'block';
      });
      path.addEventListener('mousemove', e => { tooltip.style.left = (e.clientX + 12) + 'px'; tooltip.style.top = (e.clientY + 12) + 'px'; });
      path.addEventListener('mouseleave', () => { path.classList.remove('highlighted'); path.ownerSVGElement.classList.remove('has-highlight'); tooltip.style.display = 'none'; });
    });
  }

  function renderAllCurveChart(containerId, title, ylabel, xScaleFn, xTicksFn, H, seriesArrays, refArray, zeroBased) {
    let ymin = Infinity, ymax = -Infinity;
    seriesArrays.forEach(({ values }) => values.forEach(v => { if (Number.isFinite(v)) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; } }));
    refArray.forEach(v => { if (Number.isFinite(v)) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; } });
    if (!Number.isFinite(ymin)) { ymin = 0; ymax = 1; }
    if (zeroBased) ymin = Math.min(ymin, 0);
    const pad = (ymax - ymin) * 0.08 || 1;
    ymin -= pad; ymax += pad;
    let s = axisBase(title, ymin, ymax, ylabel, H, xTicksFn);
    let paths = '';
    seriesArrays.forEach(({ label, values }) => {
      paths += `<path class="city-curve" data-label="${esc(label)}" d="${pathFrom(values, xScaleFn, ymin, ymax, H)}"/>`;
    });
    paths += `<path d="${pathFrom(refArray, xScaleFn, ymin, ymax, H)}" fill="none" stroke="var(--accent2)" stroke-width="2.4" class="global-curve" pointer-events="none"/>`;
    const container = $(containerId);
    container.innerHTML = s.replace('</svg>', paths + '</svg>');
    bindHover(container);
  }

  function renderAllCsp() {
    const ci = state.crime;
    const cspIdx = cspAreaIndices();
    const [gtrend, gtrend_season, gshared] = getGlobal(ci, 'CSP');

    const rateSeries = [], trendSeries = [], seasonSeries = [], residSeries = [];
    const natSeasonQ = nationalSeasonByQuarter(ci, 'CSP');
    const natSeasonCentered = natSeasonQ.map(v => v - natSeasonQ.reduce((a, b) => a + b, 0) / 4);

    cspIdx.forEach(ai => {
      const curve = computeAreaCurve(ci, ai);
      if (!curve) return;
      const label = areas[ai].n;
      rateSeries.push({ label, values: curve.fitted_rate });
      trendSeries.push({ label, values: curve.trend_dev });
      const season = getSeason(ci, ai).map(s => s[0]);
      seasonSeries.push({ label, values: season });
      residSeries.push({ label, values: curve.e });
    });

    const trendSeasonRate = gtrend_season.map(v => RATE_MULT * invlogit(v));
    const zero44 = new Array(NT).fill(0);
    const zero4 = new Array(4).fill(0);

    renderAllCurveChart('all-rates-chart', 'Annualised rate per 100,000', 'Rate per 100k', xScaleT, timeTicks, ALL_H, rateSeries, trendSeasonRate, true);
    renderAllCurveChart('all-trends-chart', 'Trend deviation (logit scale)', 'Logit deviation', xScaleT, timeTicks, ALL_H, trendSeries, zero44, false);
    renderAllCurveChart('all-seasons-chart', 'Seasonal deviation (logit scale)', 'Logit deviation', i => xScaleQ(i + 1), quarterTicks, ALL_H, seasonSeries, zero4, false);
    renderAllCurveChart('all-residuals-chart', 'Residual (logit scale)', 'Logit deviation', xScaleT, timeTicks, ALL_H, residSeries, zero44, false);
  }

  // ---------- render dispatch ----------
  function renderAll() {
    const activePage = document.querySelector('.page.active').id;
    if (activePage === 'overview') renderGlobal();
    else if (activePage === 'csp') renderCsp();
    else if (activePage === 'pfa') renderPfa();
    else if (activePage === 'all-csp') renderAllCsp();
  }
  renderGlobal();
})();
