/**
 * ProvChart SVG — Static SVG Renderer (ES Module)
 *
 * Same conceptual API as provchart-core.js but renders real <svg> markup
 * instead of CSS-driven divs, for use in READMEs, docs, and non-HTML contexts.
 *
 * Supports: line, area, bar (vertical/horizontal, stacked), scatter, gauge, combo.
 * Each method returns { svg, width, height }.
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

function xStops(n, plotWidth) {
  if (n <= 1) return [plotWidth / 2];
  return Array.from({ length: n }, (_, i) => round((i / (n - 1)) * plotWidth));
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));
}

// Formats a raw value for axis/label display: 1,200 -> "1.2k", 2,000,000,000 -> "2B", etc.
// Small numbers (< 1000) get plain formatting with no forced decimals.
function formatNumber(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const trim = (v) => {
    const r = round(v);
    return r % 1 === 0 ? String(r) : String(r);
  };
  if (abs >= 1e9) return sign + trim(abs / 1e12) + 'T';
  if (abs >= 1e9) return sign + trim(abs / 1e9) + 'B';
  if (abs >= 1e6) return sign + trim(abs / 1e6) + 'M';
  if (abs >= 1e3) return sign + trim(abs / 1e3) + 'k';
  return sign + trim(abs);
}

// ------------------------------------------------------------------ //
// Themes & Palette
// ------------------------------------------------------------------ //

const THEMES = {
  dark: {
    bg: '#131120',
    surface: '#191629',
    muted: '#837da0',
    text: '#eae7f5',
    grid: '#8b7bff',
    radius: 14,
    fontFamily: 'sans-serif',
  },
  light: {
    bg: '#f5f3f9',
    surface: '#ffffff',
    muted: '#6b6680',
    text: '#1a1628',
    grid: '#c0b8d6',
    radius: 14,
    fontFamily: 'sans-serif',
  },
  midnight: {
    bg: '#0c0a16',
    surface: '#141120',
    muted: '#5a5580',
    text: '#d4cef0',
    grid: '#4a4490',
    radius: 14,
    fontFamily: 'sans-serif',
  },
};

function getTheme(themeName) {
  if (typeof themeName === 'object' && themeName !== null) return { ...THEMES.dark, ...themeName };
  return THEMES[themeName] || THEMES.dark;
}

const PALETTE = ['#8b7bff', '#4fd8c4', '#f0a860', '#ff5e7d', '#4fffb0', '#5ea8ff'];

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

// Maps a raw value to a 0-100 plot percentage within the given range.
function normalize(v, range) {
  return clamp(((v - range.min) / (range.max - range.min)) * 100, 0, 100);
}

// ------------------------------------------------------------------ //
// Shared Plot Frame & Layout Helpers
// ------------------------------------------------------------------ //

function buildFrame(config, series) {
  const theme = getTheme(config.theme);
  const width = config.width || 640;
  const showAxisX = Array.isArray(config.axisX) && config.axisX.length > 0;
  const showAxisY = config.axisY !== false;
  const showLegend = config.legend !== false;
  const showGrid = config.grid !== false;
  const gridRows = (config.grid && config.grid.rows) || 5;
  const gridCols = (config.grid && config.grid.cols) || 7;

  const paddingTop = 16;
  const paddingBottom = showAxisX ? 26 : 12;
  const paddingLeft = showAxisY ? 46 : 14;
  const paddingRight = 14;
  const legendHeight = showLegend ? 30 : 0;

  const height = config.height || 320;
  const plotX = paddingLeft;
  const plotY = paddingTop;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom - legendHeight;

  return {
    theme, width, height, showAxisX, showAxisY, showLegend, showGrid, gridRows, gridCols,
    plotX, plotY, plotWidth, plotHeight,
  };
}

function gridLines(frame) {
  if (!frame.showGrid) return '';
  const { plotX, plotY, plotWidth, plotHeight, gridRows, gridCols, theme } = frame;
  let lines = '';
  for (let i = 0; i <= gridRows; i++) {
    const y = round(plotY + (plotHeight / gridRows) * i);
    lines += `<line x1="${plotX}" y1="${y}" x2="${round(plotX + plotWidth)}" y2="${y}" stroke="${theme.muted}" stroke-width="1" opacity="0.12" />`;
  }
  for (let i = 0; i <= gridCols; i++) {
    const x = round(plotX + (plotWidth / gridCols) * i);
    lines += `<line x1="${x}" y1="${plotY}" x2="${x}" y2="${round(plotY + plotHeight)}" stroke="${theme.grid}" stroke-width="1" opacity="0.12" />`;
  }
  return lines;
}

// Numeric labels down the left edge, from range.max at the top to range.min at the bottom.
function yAxisLabels(frame, range) {
  if (!frame.showAxisY) return '';
  const { plotX, plotY, plotHeight, gridRows, theme } = frame;
  let out = '';
  for (let i = 0; i <= gridRows; i++) {
    const t = 1 - i / gridRows;
    const value = range.min + t * (range.max - range.min);
    const y = round(plotY + (plotHeight / gridRows) * i);
    out += `<text x="${round(plotX - 8)}" y="${round(y + 3.5)}" font-size="10" fill="${theme.muted}" font-family="${theme.fontFamily}" text-anchor="end">${escapeXml(formatNumber(value))}</text>`;
  }
  return out;
}

function axisXLabels(frame, labels, n) {
  if (!frame.showAxisX) return '';
  const { plotX, plotWidth, plotY, plotHeight, theme } = frame;
  const stops = xStops(n, plotWidth);
  const y = round(plotY + plotHeight + 18);
  return labels
    .slice(0, n)
    .map((label, i) => {
      const x = round(plotX + (stops[i] !== undefined ? stops[i] : 0));
      return `<text x="${x}" y="${y}" font-size="11" fill="${theme.muted}" font-family="${theme.fontFamily}" text-anchor="middle">${escapeXml(label)}</text>`;
    })
    .join('');
}

function legendRow(frame, series) {
  if (!frame.showLegend) return '';
  const { theme, width, height } = frame;
  const y = height - 14;
  let x = width / 2 - series.length * 55;
  if (x < 10) x = 10;
  let items = '';
  series.forEach((s) => {
    items += `<rect x="${round(x)}" y="${y - 9}" width="10" height="10" rx="2" fill="${s.color}" />`;
    items += `<text x="${round(x + 14)}" y="${y}" font-size="12" fill="${theme.muted}" font-family="${theme.fontFamily}">${escapeXml(s.name)}</text>`;
    x += 14 + s.name.length * 6.5 + 20;
  });
  return items;
}

function wrapSvg({ width, height, theme, body }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${theme.radius}" fill="${theme.surface}" />` +
    body +
    `</svg>`;
  return { svg, width, height };
}

// ------------------------------------------------------------------ //
// Series Renderers
// ------------------------------------------------------------------ //

function normalizeSeries(config, forcedType) {
  const series = (config.series || []).map((s, i) => ({
    name: s.name || `Series ${i + 1}`,
    color: s.color || PALETTE[i % PALETTE.length],
    points: s.points || [],
    type: forcedType || s.type || 'line',
    stack: !!s.stack,
    radius: s.radius || 4,
  }));
  if (series.length === 0) throw new Error('At least one series is required.');
  if (!series[0].points.length) throw new Error('Each series must have at least one point.');
  return series;
}

function renderLineOrArea(frame, s, stops, n, defs, range) {
  const { plotX, plotY, plotHeight } = frame;
  const yFor = (v) => round(plotY + (100 - normalize(v, range)) / 100 * plotHeight);
  const pathPoints = s.points.map((v, i) => `${round(plotX + stops[i])},${yFor(v)}`);
  const linePath = `M${pathPoints.join(' L')}`;

  let fillPath = '';
  let fillAttr = 'none';
  if (s.type === 'area') {
    const gradId = uid('pcgrad');
    defs.push(`<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${s.color}" stop-opacity="0.4"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0.03"/></linearGradient>`);
    const baseline = yFor(range.min);
    fillPath = `M${pathPoints.join(' L')} L${round(plotX + stops[n - 1])},${baseline} L${round(plotX + stops[0])},${baseline} Z`;
    fillAttr = `url(#${gradId})`;
  }

  let out = '';
  if (fillPath) {
    out += `<path d="${fillPath}" fill="${fillAttr}" stroke="none" />`;
  }
  out += `<path d="${linePath}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
  return out;
}

function renderScatter(frame, s, stops, range) {
  const { plotX, plotY, plotHeight } = frame;
  return s.points
    .map((v, i) => {
      const x = round(plotX + stops[i]);
      const y = round(plotY + (100 - normalize(v, range)) / 100 * plotHeight);
      return `<circle cx="${x}" cy="${y}" r="${s.radius || 4}" fill="${s.color}" />`;
    })
    .join('');
}

function renderBars(frame, series, n, stacked, range) {
  const { plotX, plotY, plotWidth, plotHeight } = frame;
  const stops = xStops(n, plotWidth);
  const barSeries = series.filter((s) => s.type === 'bar');
  if (barSeries.length === 0) return '';

  const groupWidth = (plotWidth / n) * 0.7;
  const baseline = plotY + plotHeight;
  const span = range.max - range.min;
  let out = '';

  if (stacked) {
    const cumulative = new Array(n).fill(range.min);
    barSeries.forEach((s) => {
      s.points.forEach((v, i) => {
        const val = v || 0;
        const x = round(plotX + stops[i] - groupWidth / 2);
        const startPct = clamp(((cumulative[i] - range.min) / span) * 100, 0, 100);
        const endPct = clamp(((cumulative[i] + val - range.min) / span) * 100, 0, 100);
        const segHeight = Math.max(round(((endPct - startPct) / 100) * plotHeight), 0);
        const y = round(baseline - (endPct / 100) * plotHeight);
        out += `<rect x="${x}" y="${y}" width="${round(groupWidth)}" height="${segHeight}" fill="${s.color}" rx="2" />`;
        cumulative[i] += val;
      });
    });
  } else {
    const barWidth = groupWidth / barSeries.length;
    barSeries.forEach((s, si) => {
      s.points.forEach((v, i) => {
        const pct = normalize(v, range);
        const x = round(plotX + stops[i] - groupWidth / 2 + si * barWidth);
        const segHeight = round((pct / 100) * plotHeight);
        const y = round(baseline - segHeight);
        out += `<rect x="${x}" y="${y}" width="${round(barWidth * 0.9)}" height="${segHeight}" fill="${s.color}" rx="2" />`;
      });
    });
  }
  return out;
}

// ------------------------------------------------------------------ //
// Chart Builders
// ------------------------------------------------------------------ //

function buildLineFamily(config, forcedType) {
  const series = normalizeSeries(config, forcedType);
  const frame = buildFrame(config, series);
  const n = series[0].points.length;
  const stops = xStops(n, frame.plotWidth);
  const defs = [];
  const range = computeRange(series, config, !!config.stacked);

  let body = gridLines(frame);
  body += yAxisLabels(frame, range);

  const bars = renderBars(frame, series, n, !!config.stacked, range);
  body += bars;

  series
    .filter((s) => s.type === 'line' || s.type === 'area')
    .forEach((s) => {
      body += renderLineOrArea(frame, s, stops, n, defs, range);
    });

  series
    .filter((s) => s.type === 'scatter')
    .forEach((s) => {
      body += renderScatter(frame, s, stops, range);
    });

  body += axisXLabels(frame, config.axisX || [], n);
  body += legendRow(frame, series);

  const defsBlock = defs.length ? `<defs>${defs.join('')}</defs>` : '';
  return wrapSvg({ width: frame.width, height: frame.height, theme: frame.theme, body: defsBlock + body });
}

function buildHbar(config) {
  const theme = getTheme(config.theme);
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

  if (bars.length === 0) throw new Error('At least one bar is required.');

  const values = bars.map((b) => b.value);
  let min = typeof config.min === 'number' ? config.min : Math.min(0, ...values);
  let max = typeof config.max === 'number' ? config.max : Math.max(...values);
  if (min === max) max = min + (Math.abs(min) * 0.1 || 1);
  const span = max - min;

  const width = typeof config.width === 'number' ? config.width : 480;
  const rowHeight = 32;
  const padding = 16;
  const labelWidth = 80;
  const valueWidth = 52;
  const height = config.height || bars.length * rowHeight + padding * 2;
  const trackWidth = width - padding * 2 - labelWidth - valueWidth;

  let body = '';
  bars.forEach((b, i) => {
    const y = round(padding + i * rowHeight);
    const trackX = padding + labelWidth;
    const pct = clamp(((b.value - min) / span) * 100, 0, 100);
    const fillWidth = round((pct / 100) * trackWidth);
    body += `<text x="${padding}" y="${y + rowHeight / 2 + 4}" font-size="12" fill="${theme.text}" font-family="${theme.fontFamily}">${escapeXml(b.label)}</text>`;
    body += `<rect x="${trackX}" y="${y + rowHeight / 2 - 5}" width="${round(trackWidth)}" height="10" rx="5" fill="${theme.bg}" />`;
    body += `<rect x="${trackX}" y="${y + rowHeight / 2 - 5}" width="${fillWidth}" height="10" rx="5" fill="${b.color}" />`;
    body += `<text x="${round(trackX + trackWidth + 12)}" y="${y + rowHeight / 2 + 4}" font-size="12" fill="${theme.muted}" font-family="${theme.fontFamily}" text-anchor="start">${escapeXml(formatNumber(b.value))}</text>`;
  });

  return wrapSvg({ width, height, theme, body });
}

function buildGauge(config) {
  const theme = getTheme(config.theme);
  const size = config.size || Math.min(config.width || 180, config.height || 180) || 180;
  const strokeWidth = config.thickness || 10;
  const centerText = config.label || '';

  // Gauges stay percentage-based, but honor a custom min/max if given so the
  // ring position and center label reflect the real value, not a raw 0-100 clamp.
  const min = typeof config.min === 'number' ? config.min : 0;
  const max = typeof config.max === 'number' ? config.max : 100;
  const span = max - min || 1;
  const pctOf = (v) => clamp(((v - min) / span) * 100, 0, 100);

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

  const cx = size / 2;
  const cy = size / 2;
  const centerRadius = 40;
  const gap = strokeWidth + 4;

  let body = '';
  series.forEach((s, i) => {
    const r = centerRadius + (series.length - 1 - i) * gap;
    const circumference = 2 * Math.PI * r;
    const pct = pctOf(s.rawValue);
    const dash = round((pct / 100) * circumference);

    body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${theme.bg}" stroke-width="${strokeWidth}" />`;
    body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${strokeWidth}"
      stroke-dasharray="${dash} ${round(circumference - dash)}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})" />`;
  });

  const primaryValue = series[0].rawValue;
  const centerLabel = max === 100 && min === 0 ? `${round(primaryValue)}%` : formatNumber(primaryValue);
  body += `<text x="${cx}" y="${cy + round(size / 20)}" font-size="${round(size / 6)}" font-weight="700" fill="${theme.text}" font-family="${theme.fontFamily}" text-anchor="middle">${centerLabel}</text>`;

  if (centerText) {
    body += `<text x="${cx}" y="${cy + round(size / 7)}" font-size="11" fill="${theme.muted}" font-family="${theme.fontFamily}" text-anchor="middle">${escapeXml(centerText)}</text>`;
  }

  return wrapSvg({ width: size, height: size, theme, body });
}

// ------------------------------------------------------------------ //
// Public API Exports
// ------------------------------------------------------------------ //

export default {
  line: (config) => buildLineFamily(config, 'line'),
  area: (config) => buildLineFamily(config, 'area'),
  bar: (config) => buildLineFamily({ ...config, series: (config.series || []).map((s) => ({ ...s, type: 'bar' })) }, null),
  scatter: (config) => buildLineFamily(config, 'scatter'),
  combo: (config) => buildLineFamily(config, null),
  hbar: buildHbar,
  gauge: buildGauge,
  _internal: { xStops, escapeXml, uid, formatNumber, computeRange },
};
