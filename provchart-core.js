/**
 * latest at 22/11/26
 * ProvChart Core — Advanced CSS Chart Engine (ES Module)
 *
 * Supports: line, area, bar (vertical/horizontal), scatter, gauge, stat, combo, and radar (spider).
 * Fully CSS-driven with dynamic custom properties. Zero runtime JS after initial render.
 *
 * Value ranges are no longer hard-locked to 0-100. Pass config.min / config.max
 * to fix the axis, or leave them out and the range is inferred from the data
 * (min defaults to 0 unless your values go negative; max is the highest value
 * seen, across stacked sums when config.stacked is true).
 */

'use strict';

// ------------------------------------------------------------------ //
// Utilities
// ------------------------------------------------------------------ //

let instanceCount = 0;

function uid(prefix) {
  instanceCount += 1;
  return `${prefix}-${instanceCount}-${Math.random().toString(36).slice(2, 6)}`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// banded=false: edge-to-edge positions (first point at 0%, last at 100%) —
// correct for line/area/scatter where a point should touch the plot edge.
// banded=true: n evenly-sized bands, position = each band's center — correct
// for bars, which need clearance on both sides so they don't bleed past the
// plot edges (and, on the left, into the y-axis label column).
function xStops(n, banded = false) {
  if (n <= 1) return [50];
  if (banded) {
    return Array.from({ length: n }, (_, i) => round(((i + 0.5) / n) * 100));
  }
  return Array.from({ length: n }, (_, i) => round((i / (n - 1)) * 100));
}

function slug(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Formats a raw value for axis/label display: 1,200 -> "1.2k", 2,000,000,000 -> "2B", etc.
// Small numbers (< 1000) get plain formatting with no forced decimals.
function formatNumber(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const trim = (v) => String(round(v));
  if(abs >= 1e12) return sign + trim(abs / 1e12)+ 'T';
  if (abs >= 1e9) return sign + trim(abs / 1e9) + 'B';
  if (abs >= 1e6) return sign + trim(abs / 1e6) + 'M';
  if (abs >= 1e3) return sign + trim(abs / 1e3) + 'k';
  return sign + trim(abs);
}

// ------------------------------------------------------------------ //
// Range handling
// ------------------------------------------------------------------ //

// Computes { min, max } across all series. Honors explicit config.min/config.max.
// When stackedBar is true, bar-type series are summed per x-position before
// checking against max (so stacked totals set the ceiling, not each segment).
function computeRange(series, config, stackedBar) {
  const autoMin = typeof config.min !== 'number';
  const autoMax = typeof config.max !== 'number';
  let min = autoMin ? Infinity : config.min;
  let max = autoMax ? -Infinity : config.max;

  const n = series[0] ? series[0].points.length : 0;
  const barSeries = series.filter((s) => s.type === 'bar');
  const otherSeries = series.filter((s) => s.type !== 'bar');

  if (stackedBar && barSeries.length) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      barSeries.forEach((s) => {
        sum += s.points[i] || 0;
      });
      if (autoMax && sum > max) max = sum;
      if (autoMin && sum < min) min = sum;
    }
  } else {
    barSeries.forEach((s) => s.points.forEach((v) => {
      if (autoMax && v > max) max = v;
      if (autoMin && v < min) min = v;
    }));
  }

  otherSeries.forEach((s) => s.points.forEach((v) => {
    if (autoMax && v > max) max = v;
    if (autoMin && v < min) min = v;
  }));

  if (autoMin && min === Infinity) min = 0;
  if (autoMax && max === -Infinity) max = 100;
  if (autoMin && min > 0) min = 0; // default baseline at 0 unless data actually goes negative
  if (min === max) max = min + (Math.abs(min) * 0.1 || 1);

  return { min, max };
}

// Maps a raw value to a 0-100 percentage within the given range.
function normalize(v, range) {
  return clamp(((v - range.min) / (range.max - range.min)) * 100, 0, 100);
}

// ------------------------------------------------------------------ //
// Themes & Colors
// ------------------------------------------------------------------ //

const THEMES = {
  dark: {
    bg: '#131120',
    surface: '#191629',
    muted: '#837da0',
    text: '#eae7f5',
    grid: '#8b7bff',
    radius: '14px',
    fontFamily: 'inherit',
  },
  light: {
    bg: '#f5f3f9',
    surface: '#ffffff',
    muted: '#6b6680',
    text: '#1a1628',
    grid: '#c0b8d6',
    radius: '14px',
    fontFamily: 'inherit',
  },
  midnight: {
    bg: '#0c0a16',
    surface: '#141120',
    muted: '#5a5580',
    text: '#d4cef0',
    grid: '#4a4490',
    radius: '14px',
    fontFamily: 'inherit',
  },
};

function getTheme(themeName) {
  if (typeof themeName === 'object') return { ...THEMES.dark, ...themeName };
  return THEMES[themeName] || THEMES.dark;
}

const PALETTE = ['#8b7bff', '#4fd8c4', '#f0a860', '#ff5e7d', '#4fffb0', '#5ea8ff'];

// ------------------------------------------------------------------ //
// Helpers for CSS and HTML
// ------------------------------------------------------------------ //

function pointVarBlock(id, seriesIndex, points, range, invert = true) {
  return points
    .map((v, i) => {
      const pct = normalize(v, range);
      const val = invert ? 100 - pct : pct;
      return `--pc-${id}-s${seriesIndex}-p${i + 1}: ${round(val)}%;`;
    })
    .join(' ');
}

function generateGridCSS(id, theme, rows, cols) {
  if (!rows && !cols) return '';
  return `
.pc-${id} .pc-grid {
  position: absolute; inset: 0;
  background:
    ${rows ? `repeating-linear-gradient(to bottom, ${theme.muted} 0, ${theme.muted} 1px, transparent 1px, transparent calc(100% / ${rows})),` : ''}
    ${cols ? `repeating-linear-gradient(to right, ${theme.grid} 0, ${theme.grid} 1px, transparent 1px, transparent calc(100% / ${cols}));` : ''}
  opacity: 0.1;
  pointer-events: none;
}`;
}

function generateAxisXHTML(id, labels) {
  if (!labels || labels.length === 0) return '';
  return `
    <div class="pc-${id}-axis-x">
      ${labels.map(label => `<span>${label}</span>`).join('')}
    </div>`;
}

function generateAxisXCSS(id, theme) {
  return `
.pc-${id}-axis-x {
  position: absolute; left: 0; right: 0; bottom: 6px;
  display: flex; justify-content: space-between;
  padding-inline: 12px;
  font-size: 11px; color: ${theme.muted};
}`;
}

// Numeric labels down the left edge, from range.max at the top to range.min
// at the bottom, spaced to match the horizontal gridlines.
function generateAxisYHTML(id, range, rows) {
  const gridRows = rows || 5;
  let items = '';
  for (let i = 0; i <= gridRows; i++) {
    const t = i / gridRows; // 0 = top (max), 1 = bottom (min)
    const value = range.max - t * (range.max - range.min);
    items += `<span style="position:absolute;left:0;right:4px;top:${round(t * 100)}%;transform:translateY(-50%);text-align:right;">${formatNumber(value)}</span>`;
  }
  return `<div class="pc-${id}-axis-y">${items}</div>`;
}

function generateAxisYCSS(id, theme) {
  return `
.pc-${id}-axis-y {
  position: relative;
  width: 38px;
  flex: none;
  font-size: 10px;
  color: ${theme.muted};
  font-variant-numeric: tabular-nums;
}`;
}

// ------------------------------------------------------------------ //
// Core Chart Builder (Line, Area, Bar, Scatter, Combo)
// ------------------------------------------------------------------ //

function buildChart(config, type) {
  const id = config.id || uid('chart');
  const theme = getTheme(config.theme);
  const width = config.width || '100%';
  const height = config.height || 220;
  const showGrid = config.grid !== false;
  const gridRows = (config.grid && config.grid.rows) || 5;
  const gridCols = (config.grid && config.grid.cols) || 7;
  const showAxisX = Array.isArray(config.axisX) && config.axisX.length > 0;
  const showAxisY = config.axisY !== false;

  let series = (config.series || []).map((s, i) => ({
    name: s.name || `Series ${i + 1}`,
    color: s.color || PALETTE[i % PALETTE.length],
    points: s.points || [],
    type: s.type || type || 'line',
    stack: !!s.stack,
    radius: s.radius || 4,
  }));

  if (series.length === 0) throw new Error('At least one series is required.');
  const n = series[0].points.length;
  if (n === 0) throw new Error('Each series must have at least one point.');
  // Bars need banded (evenly-boxed) positions so they never bleed past the
  // plot edges — line/area/scatter keep edge-to-edge positions.
  const hasBar = series.some((s) => s.type === 'bar');
  const stops = xStops(n, hasBar);
  const stacked = !!config.stacked;
  const range = computeRange(series, config, stacked);

  const varBlocks = series
    .map((s, i) => pointVarBlock(id, i + 1, s.points, range, true))
    .join(' ');

  // Raw per-series values, exposed as data-* attributes on the root element so
  // runtime tooltips can show the real number instead of reverse-engineering
  // it from a plotted % position (which is only meaningful within `range`).
  const rawDataAttrs = series
    .map((s, i) => `data-pc-s${i + 1}="${s.points.join(',')}"`)
    .join(' ');

  const seriesRules = series.map((s, i) => {
    const si = i + 1;
    let rule = '';

    if (s.type === 'line') {
      const top = stops.map((x, j) => `${x}% var(--pc-${id}-s${si}-p${j + 1})`).join(', ');
      const bottom = stops.slice().reverse().map((x, j) => {
        const pIndex = n - j;
        return `${x}% calc(var(--pc-${id}-s${si}-p${pIndex}) + var(--pc-${id}-lw))`;
      }).join(', ');
      
      rule = `
.pc-${id} .pc-series-${si} {
  position: absolute; inset: 0;
  background: ${s.color};
  clip-path: polygon(${top}, ${bottom});
  transition: clip-path 700ms cubic-bezier(.4,0,.2,1);
  filter: drop-shadow(0 0 5px ${s.color}88);
}`;
    } else if (s.type === 'area') {
      const top = stops.map((x, j) => `${x}% var(--pc-${id}-s${si}-p${j + 1})`).join(', ');
      const areaPolygon = `${top}, 100% 100%, 0% 100%`;

      rule = `
.pc-${id} .pc-series-${si} {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, ${s.color}66 0%, ${s.color}05 100%);
  clip-path: polygon(${areaPolygon});
  transition: clip-path 700ms cubic-bezier(.4,0,.2,1);
}`;
    }
    return rule;
  }).filter(Boolean).join('\n');

  let layersHtml = '';
  let barHtml = '';
  let scatterHtml = '';

  if (stacked) {
    const barSeries = series.filter((s) => s.type === 'bar');
    const cumulative = new Array(n).fill(range.min);
    barSeries.forEach((s) => {
      const si = series.indexOf(s) + 1;
      const bars = s.points.map((v, idx) => {
        const val = v || 0;
        const x = stops[idx];
        const barWidth = (100 / n) * 0.6;
        const left = x - barWidth / 2;
        const startPct = normalize(cumulative[idx], range);
        const endPct = normalize(cumulative[idx] + val, range);
        const segHeight = Math.max(round(endPct - startPct), 0);
        cumulative[idx] += val;
        return `<div class="pc-bar-${si}-${idx}" data-value="${val}" style="left:${left}%;width:${barWidth}%;height:${segHeight}%;bottom:${round(startPct)}%;background:${s.color};position:absolute;border-radius:3px 3px 0 0;transition:height 600ms ease, bottom 600ms ease;"></div>`;
      }).join('');
      barHtml += `    <div class="pc-bar-group-${si}" style="position:absolute;inset:0;pointer-events:none;">${bars}</div>\n`;
    });
  }

  series.forEach((s, i) => {
    const si = i + 1;
    if (s.type === 'line' || s.type === 'area') {
      layersHtml += `    <div class="pc-series-${si}"></div>\n`;
    } else if (s.type === 'bar' && !stacked) {
      const bars = s.points.map((v, idx) => {
        const x = stops[idx];
        const barWidth = (100 / n) * 0.6;
        const left = x - barWidth / 2;
        const h = normalize(v, range);
        return `<div class="pc-bar-${si}-${idx}" data-value="${v}" style="left:${left}%;width:${barWidth}%;height:${round(h)}%;bottom:0;background:${s.color};position:absolute;border-radius:3px 3px 0 0;transition:height 600ms ease;"></div>`;
      }).join('');
      barHtml += `    <div class="pc-bar-group-${si}" style="position:absolute;inset:0;pointer-events:none;">${bars}</div>\n`;
    } else if (s.type === 'scatter') {
      const points = s.points.map((v, idx) => {
        const x = stops[idx];
        const y = 100 - normalize(v, range);
        return `<circle cx="${x}%" cy="${y}%" r="${s.radius}" fill="${s.color}" data-value="${v}" />`;
      }).join('');
      scatterHtml += `    <svg class="pc-scatter-${si}" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;">${points}</svg>\n`;
    }
  });

  const layers = layersHtml + barHtml + scatterHtml;
  const gridCss = showGrid ? generateGridCSS(id, theme, gridRows, gridCols) : '';
  const axisXHtml = showAxisX ? generateAxisXHTML(id, config.axisX) : '';
  const axisXCss = showAxisX ? generateAxisXCSS(id, theme) : '';
  const axisYHtml = showAxisY ? generateAxisYHTML(id, range, gridRows) : '';
  const axisYCss = showAxisY ? generateAxisYCSS(id, theme) : '';

  let legendHtml = '';
  if (config.legend !== false) {
    const items = series.map((s) => `<span><i style="display:inline-block;width:10px;height:10px;background:${s.color};border-radius:2px;margin-right:6px;"></i>${s.name}</span>`).join('');
    legendHtml = `
    <div class="pc-${id}-legend" style="display:flex;gap:16px;padding:8px 12px;font-size:12px;color:${theme.muted};flex-wrap:wrap;justify-content:center;">
      ${items}
    </div>`;
  }

  const css = `
.pc-${id} {
  --pc-${id}-lw: 2px;
  ${varBlocks}
  position: relative;
  width: ${width};
  height: ${height}px;
  background: ${theme.surface};
  border-radius: ${theme.radius};
  overflow: hidden;
  font-family: ${theme.fontFamily};
  display: flex;
  flex-direction: column;
}
.pc-${id} .pc-chart-row {
  flex: 1;
  display: flex;
  min-height: 0;
}
.pc-${id} .pc-chart-area {
  flex: 1;
  position: relative;
  min-height: 0;
  min-width: 0;
}
${axisYCss}
${gridCss}
${seriesRules}
${axisXCss}
`.trim();

  const html = `<div class="pc-${id}" data-provchart="${type}" ${rawDataAttrs}>
  <div class="pc-chart-row">
    ${axisYHtml}
    <div class="pc-chart-area">
      ${showGrid ? `<div class="pc-grid"></div>` : ''}
      ${layers}
      ${axisXHtml}
    </div>
  </div>
  ${legendHtml}
</div>`;

  const update = function (seriesIndex, points, el) {
    const target = el || document.querySelector(`.pc-${id}`);
    if (!target) return;
    points.forEach((v, i) => {
      const pct = normalize(v, range);
      target.style.setProperty(`--pc-${id}-s${seriesIndex}-p${i + 1}`, `${round(100 - pct)}%`);
    });
    // Keep the raw-value attribute in sync so runtime tooltips stay accurate
    // after a live update (line/area only — bars and scatter are static markup).
    target.setAttribute(`data-pc-s${seriesIndex}`, points.join(','));
  };

  return { id, html, css, update };
}

// ------------------------------------------------------------------ //
// Build Horizontal Bar (HBar)
// ------------------------------------------------------------------ //

function buildHBar(config) {
  const id = config.id || uid('hbar');
  const theme = getTheme(config.theme);
  const width = config.width || '100%';
  const height = config.height;

  const bars = (config.bars || config.series?.[0]?.points || []).map((v, i) => {
    const isObj = v && typeof v === 'object' && !Array.isArray(v);
    return {
      label:
        (isObj && v.label) ||
        config.axisX?.[i] ||
        config.series?.[0]?.name ||
        `Item ${i + 1}`,
      value: isObj ? v.value : v,
      color:
        (isObj && v.color) ||
        config.series?.[0]?.color ||
        PALETTE[i % PALETTE.length],
    };
  });

  if (!bars.length && config.series?.length) {
    config.series[0].points.forEach((v, i) => {
      bars.push({
        label: config.axisX?.[i] || `Item ${i + 1}`,
        value: v,
        color: config.series[0].color || PALETTE[0],
      });
    });
  }

  if (!bars.length) throw new Error('At least one bar is required.');

  const values = bars.map((b) => b.value);
  let min = typeof config.min === 'number' ? config.min : Math.min(0, ...values);
  let max = typeof config.max === 'number' ? config.max : Math.max(...values);
  if (min === max) max = min + (Math.abs(min) * 0.1 || 1);
  const span = max - min;
  const pctOf = (v) => clamp(((v - min) / span) * 100, 0, 100);

  const rows = bars
    .map(
      (b, i) => `
    <div class="pc-${id}-row" data-index="${i}" data-value="${b.value}">
      <span class="pc-${id}-label">${b.label}</span>
      <div class="pc-${id}-track">
        <div class="pc-${id}-fill" style="width:${round(pctOf(b.value))}%;background:${b.color};"></div>
      </div>
      <span class="pc-${id}-val">${formatNumber(b.value)}</span>
    </div>`
    )
    .join('');

  const css = `
.pc-${id} {
  width: ${width};
  ${height ? `height: ${height}px;` : ''}
  background: ${theme.surface};
  border-radius: ${theme.radius};
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: ${theme.fontFamily};
  box-sizing: border-box;
}
.pc-${id}-row {
  display: grid;
  grid-template-columns: minmax(56px, 28%) 1fr auto;
  align-items: center;
  gap: 12px;
}
.pc-${id}-label {
  font-size: 12px;
  color: ${theme.text};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pc-${id}-track {
  height: 10px;
  border-radius: 999px;
  background: ${theme.bg};
  overflow: hidden;
}
.pc-${id}-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 600ms ease;
  min-width: 0;
}
.pc-${id}-val {
  font-size: 12px;
  color: ${theme.muted};
  min-width: 3.5ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
}`.trim();

  const html = `<div class="pc-${id}" data-provchart="hbar">${rows}</div>`;

  const update = function (index, value, el) {
    const container = el || document.querySelector(`.pc-${id}`);
    if (!container) return;
    const row = container.querySelector(`.pc-${id}-row[data-index="${index}"]`);
    if (!row) return;
    const pct = pctOf(value);
    const fill = row.querySelector(`.pc-${id}-fill`);
    const val = row.querySelector(`.pc-${id}-val`);
    if (fill) fill.style.width = `${round(pct)}%`;
    if (val) val.textContent = formatNumber(value);
    row.dataset.value = value;
  };

  return { id, html, css, update };
}

// ------------------------------------------------------------------ //
// Build Dynamic Gauge (Single or Multi-Series Radial)
// ------------------------------------------------------------------ //

function buildGauge(config) {
  const id = config.id || uid('gauge');
  const theme = getTheme(config.theme);
  const size = config.size || 180;
  const strokeWidth = config.thickness || 10;
  const centerText = config.label || '';

  // Gauges stay ring-based (0-100% visually), but honor a custom min/max so
  // the ring position and center label reflect the real value, not a raw clamp.
  const min = typeof config.min === 'number' ? config.min : 0;
  const max = typeof config.max === 'number' ? config.max : 100;
  const span = max - min || 1;
  const pctOf = (v) => clamp(((v - min) / span) * 100, 0, 100);
  const isPlainPercent = min === 0 && max === 100;

  let series = [];
  if (Array.isArray(config.series) && config.series.length) {
    series = config.series.map((s, i) => ({
      name: s.name || `Series ${i + 1}`,
      rawValue: s.value ?? s.points?.[0] ?? 0,
      color: s.color || PALETTE[i % PALETTE.length],
    }));
  } else {
    series = [
      {
        name: config.label || 'Value',
        rawValue: config.value ?? 0,
        color: config.color || PALETTE[0],
      },
    ];
  }

  const centerRadius = 50;
  const gap = strokeWidth + 4;
  const maxRadius = centerRadius + series.length * gap;
  const viewBoxSize = maxRadius * 2 + strokeWidth + 10;
  const centerPoint = viewBoxSize / 2;

  const tracks = series
    .map((s, i) => {
      const r = centerRadius + (series.length - 1 - i) * gap;
      const circumference = 2 * Math.PI * r;
      const pct = pctOf(s.rawValue);
      const offset = circumference - (pct / 100) * circumference;

      return `
      <circle class="pc-${id}-bg-ring" cx="${centerPoint}" cy="${centerPoint}" r="${r}" stroke="${theme.bg}" stroke-width="${strokeWidth}" fill="none" />
      <circle class="pc-${id}-ring" data-series="${i}" data-value="${s.rawValue}" cx="${centerPoint}" cy="${centerPoint}" r="${r}" 
              stroke="${s.color}" stroke-width="${strokeWidth}" fill="none"
              stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
              stroke-linecap="round"
              style="transform-origin: center; transform: rotate(-90deg); transition: stroke-dashoffset 700ms ease;" />`;
    })
    .join('');

  const primaryValue = series[0].rawValue;
  const centerLabel = isPlainPercent ? `${round(primaryValue)}%` : formatNumber(primaryValue);

  const css = `
.pc-${id} {
  position: relative;
  width: ${size}px;
  height: ${size}px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: ${theme.fontFamily};
}
.pc-${id} svg {
  width: 100%;
  height: 100%;
}
.pc-${id}-info {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  pointer-events: none;
}
.pc-${id}-val {
  font-size: ${round(size / 6)}px;
  font-weight: 700;
  color: ${theme.text};
  line-height: 1;
}
.pc-${id}-lbl {
  font-size: 11px;
  color: ${theme.muted};
  margin-top: 4px;
}`.trim();

  const html = `
<div class="pc-${id}" data-provchart="gauge" data-pc-plain-percent="${isPlainPercent ? 1 : 0}">
  <svg viewBox="0 0 ${viewBoxSize} ${viewBoxSize}">
    ${tracks}
  </svg>
  <div class="pc-${id}-info">
    <span class="pc-${id}-val" data-value="${primaryValue}">${centerLabel}</span>
    ${centerText ? `<span class="pc-${id}-lbl">${centerText}</span>` : ''}
  </div>
</div>`.trim();

  const update = function (indexOrVal, value, el) {
    let targetIdx = 0;
    let targetRaw = 0;

    if (typeof value === 'number') {
      targetIdx = indexOrVal;
      targetRaw = value;
    } else {
      targetRaw = indexOrVal;
    }

    const container = el || document.querySelector(`.pc-${id}`);
    if (!container) return;

    const pct = pctOf(targetRaw);
    const ring = container.querySelector(`.pc-${id}-ring[data-series="${targetIdx}"]`);
    if (ring) {
      const r = parseFloat(ring.getAttribute('r'));
      const circumference = 2 * Math.PI * r;
      const offset = circumference - (pct / 100) * circumference;
      ring.style.strokeDashoffset = offset;
    }

    if (ring) ring.setAttribute('data-value', targetRaw);

    if (targetIdx === 0) {
      const label = container.querySelector(`.pc-${id}-val`);
      if (label) {
        label.textContent = isPlainPercent ? `${round(targetRaw)}%` : formatNumber(targetRaw);
        label.setAttribute('data-value', targetRaw);
      }
    }
  };

  return { id, html, css, update };
}

// ------------------------------------------------------------------ //
// Build Radar / Spider (polar)
// ------------------------------------------------------------------ //

// Ported from the st-core.fscss spider charts. Same polar model: axis 0 sits
// at the top, axes run clockwise, vertex = center + r * (sin, -cos). The
// vertex math runs at generation time and lands in CSS custom properties as
// plain percentages, so the browser needs no CSS trig functions and update()
// only rewrites variables, like the line/area charts.
const RADAR_R = 38;       // outer ring radius, % of the stage box
const RADAR_LABEL_R = 43; // axis label radius, % of the stage box

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Auto max rounds up to a "nice" ring step so ring labels read 25/50/75/100
// instead of 23/46/69/92.
function niceMax(span, steps) {
  if (!(span > 0)) return 1;
  const raw = span / steps;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = [1, 2, 2.5, 5, 10].find((m) => norm <= m + 1e-9);
  return mult * mag * steps;
}

function buildRadar(config) {
  const id = config.id || uid('radar');
  const theme = getTheme(config.theme);
  const width = config.width || '100%';
  const height = config.height || 320;
  const showGrid = config.grid !== false;
  const showAxisY = config.axisY !== false;
  const showLegend = config.legend !== false;
  const rings = Math.max(1, Math.round((config.grid && config.grid.rows) || 4));
  const polygonGrid = config.gridShape === 'polygon';
  const labels = Array.isArray(config.axisX) ? config.axisX : [];

  const series = (config.series || []).map((s, i) => ({
    name: s.name || `Series ${i + 1}`,
    color: s.color || PALETTE[i % PALETTE.length],
    points: s.points || [],
    type: 'radar',
  }));
  if (series.length === 0) throw new Error('At least one series is required.');
  const n = series[0].points.length;
  if (n < 3) throw new Error('Radar charts need at least 3 axes (3 points per series).');

  let range = computeRange(series, config, false);
  if (typeof config.max !== 'number') {
    range = { min: range.min, max: range.min + niceMax(range.max - range.min, rings) };
  }

  const idxs = Array.from({ length: n }, (_, i) => i);
  const sinA = (i) => Math.sin((i * 2 * Math.PI) / n);
  const cosA = (i) => Math.cos((i * 2 * Math.PI) / n);
  const k4 = (v) => Math.round(v * 10000) / 10000;
  const vx = (i, pct) => round(50 + (pct / 100) * RADAR_R * sinA(i));
  const vy = (i, pct) => round(50 - (pct / 100) * RADAR_R * cosA(i));
  const valueAt = (points, i) => (typeof points[i] === 'number' ? points[i] : range.min);

  const varsFor = (si, points) => idxs.map((i) => {
    const pct = normalize(valueAt(points, i), range);
    return `--pc-${id}-s${si}-x${i + 1}: ${vx(i, pct)}%; --pc-${id}-s${si}-y${i + 1}: ${vy(i, pct)}%;`;
  }).join(' ');
  const varBlocks = series.map((s, i) => varsFor(i + 1, s.points)).join(' ');

  // Raw per-series values for runtime tooltips (same contract as line/area).
  const rawDataAttrs = series
    .map((s, i) => `data-pc-s${i + 1}="${idxs.map((k) => valueAt(s.points, k)).join(',')}"`)
    .join(' ');

  // Fill = closed polygon. Line = the same polygon minus a copy nudged
  // toward the center by --lw (evenodd keeps the hole open), so the stroke
  // has a real width without any SVG.
  const seriesRules = series.map((s, i) => {
    const si = i + 1;
    const X = (k) => `var(--pc-${id}-s${si}-x${k + 1})`;
    const Y = (k) => `var(--pc-${id}-s${si}-y${k + 1})`;
    const outer = idxs.map((k) => `${X(k)} ${Y(k)}`);
    const inner = idxs.map((k) =>
      `calc(${X(k)} - var(--pc-${id}-lw) * ${k4(sinA(k))}) calc(${Y(k)} + var(--pc-${id}-lw) * ${k4(cosA(k))})`);
    return `
.pc-${id} .pc-series-${si} { position: absolute; inset: 0; pointer-events: none; }
.pc-${id} .pc-radar-fill-${si} {
  position: absolute; inset: 0;
  background: color-mix(in srgb, ${s.color} 28%, transparent);
  clip-path: polygon(${outer.join(', ')});
  transition: clip-path 700ms cubic-bezier(.4,0,.2,1);
}
.pc-${id} .pc-radar-line-${si} {
  position: absolute; inset: 0;
  background: ${s.color};
  clip-path: polygon(evenodd, ${outer.join(', ')}, ${outer[0]}, ${inner.join(', ')}, ${inner[0]});
  transition: clip-path 700ms cubic-bezier(.4,0,.2,1);
}`;
  }).join('\n');

  const seriesHtml = series.map((s, i) => {
    const si = i + 1;
    const dots = idxs.map((k) => {
      const lbl = labels[k] !== undefined ? ` data-label="${esc(labels[k])}"` : '';
      return `<i class="pc-radar-dot" data-series="${si}" data-index="${k}" data-value="${valueAt(s.points, k)}"${lbl} style="left:var(--pc-${id}-s${si}-x${k + 1});top:var(--pc-${id}-s${si}-y${k + 1});border-color:${s.color};"></i>`;
    }).join('');
    return `<div class="pc-series-${si}"><div class="pc-radar-fill-${si}"></div><div class="pc-radar-line-${si}"></div>${dots}</div>`;
  }).join('\n      ');

  // Grid: concentric rings (circle = radial-gradient like st-core, polygon =
  // one evenodd-clipped ring per step) plus one spoke per axis.
  let gridCss = '';
  let gridHtml = '';
  if (showGrid) {
    if (polygonGrid) {
      for (let k = 1; k <= rings; k++) {
        const pct = (k / rings) * 100;
        const o = idxs.map((i) => `${vx(i, pct)}% ${vy(i, pct)}%`);
        const inn = idxs.map((i) => `calc(${vx(i, pct)}% - 1px * ${k4(sinA(i))}) calc(${vy(i, pct)}% + 1px * ${k4(cosA(i))})`);
        gridCss += `.pc-${id} .pc-radar-ring-${k} { position: absolute; inset: 0; pointer-events: none; background: ${theme.muted}; opacity: 0.22; clip-path: polygon(evenodd, ${o.join(', ')}, ${o[0]}, ${inn.join(', ')}, ${inn[0]}); }\n`;
        gridHtml += `<div class="pc-radar-ring-${k}"></div>`;
      }
    } else {
      const stops = [];
      for (let k = 1; k <= rings; k++) {
        const pos = round((k / rings) * RADAR_R * 2); // % of the closest-side radius (= 50% of the box)
        stops.push(`transparent calc(${pos}% - 1px)`, `${theme.muted} calc(${pos}% - 1px)`, `${theme.muted} ${pos}%`, `transparent ${pos}%`);
      }
      gridCss += `.pc-${id} .pc-radar-rings { position: absolute; inset: 0; pointer-events: none; opacity: 0.22; background: radial-gradient(circle closest-side at 50% 50%, ${stops.join(', ')}, transparent 100%); }\n`;
      gridHtml += `<div class="pc-radar-rings"></div>`;
    }
    gridCss += `.pc-${id} .pc-radar-spokes { position: absolute; inset: 0; pointer-events: none; }
.pc-${id} .pc-radar-spokes i { position: absolute; left: 50%; bottom: 50%; width: 1px; height: ${RADAR_R}%; margin-left: -0.5px; transform-origin: 50% 100%; background: ${theme.grid}; opacity: 0.25; }
`;
    gridHtml += `<div class="pc-radar-spokes">${idxs.map((i) => `<i style="transform:rotate(${round((i * 360) / n)}deg)"></i>`).join('')}</div>`;
  }

  let ringValHtml = '';
  if (showAxisY) {
    for (let k = 1; k <= rings; k++) {
      const value = range.min + (k / rings) * (range.max - range.min);
      ringValHtml += `<span class="pc-radar-ringval" style="top:${round(50 - (k / rings) * RADAR_R)}%">${formatNumber(value)}</span>`;
    }
  }

  const labelsHtml = idxs.filter((i) => labels[i] !== undefined).map((i) => {
    const lx = round(50 + RADAR_LABEL_R * sinA(i));
    const ly = round(50 - RADAR_LABEL_R * cosA(i));
    const tx = round(-50 + 50 * sinA(i));
    const ty = round(-50 - 50 * cosA(i));
    return `<span class="pc-radar-label" style="left:${lx}%;top:${ly}%;transform:translate(${tx}%,${ty}%);">${esc(labels[i])}</span>`;
  }).join('');

  let legendHtml = '';
  if (showLegend) {
    const items = series.map((s) => `<span><i style="display:inline-block;width:10px;height:10px;background:${s.color};border-radius:2px;margin-right:6px;"></i>${esc(s.name)}</span>`).join('');
    legendHtml = `
    <div class="pc-${id}-legend" style="display:flex;gap:16px;padding:8px 12px;font-size:12px;color:${theme.muted};flex-wrap:wrap;justify-content:center;">
      ${items}
    </div>`;
  }

  const stagePx = Math.max(120, height - 44 - (showLegend ? 34 : 0));

  const css = `
.pc-${id} {
  --pc-${id}-lw: 2px;
  ${varBlocks}
  position: relative;
  width: ${width};
  height: ${height}px;
  background: ${theme.surface};
  border-radius: ${theme.radius};
  overflow: hidden;
  font-family: ${theme.fontFamily};
  display: flex;
  flex-direction: column;
}
.pc-${id} .pc-radar-frame {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 22px 30px;
  box-sizing: border-box;
}
.pc-${id} .pc-radar {
  position: relative;
  flex: none;
  width: min(100%, ${stagePx}px);
  aspect-ratio: 1 / 1;
}
${gridCss}.pc-${id} .pc-radar-ringval {
  position: absolute; left: 50%;
  transform: translate(3px, -100%);
  font-size: 9px; line-height: 1; white-space: nowrap;
  color: ${theme.muted};
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
${seriesRules}
.pc-${id} .pc-radar-dot {
  position: absolute;
  width: 9px; height: 9px;
  margin: -4.5px 0 0 -4.5px;
  box-sizing: border-box;
  border-radius: 50%;
  background: #fff;
  border: 2px solid;
  pointer-events: auto;
  z-index: 2;
  transition: left 700ms cubic-bezier(.4,0,.2,1), top 700ms cubic-bezier(.4,0,.2,1);
}
.pc-${id} .pc-radar-label {
  position: absolute;
  font-size: 11px; line-height: 1.2; white-space: nowrap;
  color: ${theme.text};
  pointer-events: none;
  z-index: 3;
}
`.trim();

  const html = `<div class="pc-${id}" data-provchart="radar" ${rawDataAttrs}>
  <div class="pc-radar-frame">
    <div class="pc-radar">
      ${gridHtml}
      ${ringValHtml}
      ${seriesHtml}
      ${labelsHtml}
    </div>
  </div>
  ${legendHtml}
</div>`;

  const update = function (seriesIndex, points, el) {
    const target = el || document.querySelector(`.pc-${id}`);
    if (!target) return;
    idxs.forEach((i) => {
      const pct = normalize(valueAt(points, i), range);
      target.style.setProperty(`--pc-${id}-s${seriesIndex}-x${i + 1}`, `${vx(i, pct)}%`);
      target.style.setProperty(`--pc-${id}-s${seriesIndex}-y${i + 1}`, `${vy(i, pct)}%`);
    });
    target.setAttribute(`data-pc-s${seriesIndex}`, idxs.map((i) => valueAt(points, i)).join(','));
    target.querySelectorAll(`.pc-radar-dot[data-series="${seriesIndex}"]`).forEach((d) => {
      d.setAttribute('data-value', valueAt(points, Number(d.getAttribute('data-index'))));
    });
  };

  return { id, html, css, update };
}

// ------------------------------------------------------------------ //
// Public API Exports
// ------------------------------------------------------------------ //

export default {
  line: (config) => buildChart({ ...config, series: (config.series || []).map(s => ({ ...s, type: 'line' })) }, 'line'),
  area: (config) => buildChart({ ...config, series: (config.series || []).map(s => ({ ...s, type: 'area' })) }, 'area'),
  bar: (config) => buildChart({ ...config, series: (config.series || []).map(s => ({ ...s, type: 'bar' })) }, 'bar'),
  hbar: buildHBar,
  radar: buildRadar,
  spider: buildRadar,
  scatter: (config) => buildChart({ ...config, series: (config.series || []).map(s => ({ ...s, type: 'scatter' })) }, 'scatter'),
  combo: (config) => buildChart(config, 'combo'),
  gauge: buildGauge,
  stat: (config) => {
    const id = config.id || uid('stat');
    const theme = getTheme(config.theme);
    const deltaUp = config.delta && String(config.delta).trim().startsWith('+');
    
    const css = `
.pc-${id} {
  background: ${theme.surface};
  border-radius: ${theme.radius};
  padding: 20px;
  display: flex; flex-direction: column; gap: 6px;
  font-family: ${theme.fontFamily};
}
.pc-${id} .pc-stat-label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: ${theme.muted}; }
.pc-${id} .pc-stat-value { font-size: 26px; font-weight: 700; color: ${theme.text}; }
.pc-${id} .pc-stat-delta { font-size: 12px; font-weight: 600; color: ${deltaUp ? '#4fffb0' : '#ff5e7d'}; }`.trim();

    const html = `<div class="pc-${id}" data-provchart="stat">
  <span class="pc-stat-label">${config.label || 'Metric'}</span>
  <span class="pc-stat-value">${config.value || '0'}</span>
  ${config.delta ? `<span class="pc-stat-delta">${config.delta}</span>` : ''}
</div>`;

    return { id, html, css };
  },
  combine: (results) => ({
    html: results.map(r => r.html).join('\n\n'),
    css: results.map(r => r.css).join('\n\n'),
  }),
  _internal: { xStops, slug, uid, formatNumber, computeRange, niceMax },
};

