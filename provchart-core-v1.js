/**
 * ProvChart Core — the compile engine (ES Module version)
 *
 * Takes plain JS data + config, returns { html, css } — two strings you can
 * drop into any page. No FSCSS syntax to write, no preprocessor to run, no
 * fixed 8-point limit. Every chart supports an arbitrary number of points.
 *
 * Output is fully self-contained and scoped per chart (via a generated id),
 * so multiple charts can sit on the same page — or a README, or a docs
 * site — without colliding.
 *
 * If you connect live data later, the ONLY thing you write at runtime is
 * a set of CSS custom properties (--pc-{id}-p1, --pc-{id}-p2 ...). The
 * shape itself is still drawn entirely by CSS.
 *
 * No build step required — import this module directly.
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

/** Even x-stops across n points, 0–100 scale. A single point sits at 0%. */
function xStops(n) {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => round((i / (n - 1)) * 100));
}

/** Escape a string for safe use as part of a CSS class name. */
function slug(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const DEFAULT_THEME = {
  bg: '#131120',
  surface: '#191629',
  muted: '#837da0',
  text: '#eae7f5',
  grid: '#8b7bff',
  radius: '14px',
};

const PALETTE = ['#8b7bff', '#4fd8c4', '#f0a860', '#ff5e7d', '#4fffb0', '#5ea8ff'];

// ------------------------------------------------------------------ //
// Shared: CSS variable block for one series' points
// ------------------------------------------------------------------ //

function pointVarBlock(id, seriesIndex, points, invert) {
  return points
    .map((v, i) => {
      const val = invert ? 100 - clamp(v, 0, 100) : clamp(v, 0, 100);
      return `--pc-${id}-s${seriesIndex}-p${i + 1}: ${round(val)}%;`;
    })
    .join(' ');
}

// ------------------------------------------------------------------ //
// Line chart (single or multi-series)
// ------------------------------------------------------------------ //

function buildLine(config) {
  const id = config.id || uid('line');
  const width = config.width || '100%';
  const height = config.height || 220;
  const lineWidth = config.lineWidth || 2;
  const showGrid = config.grid !== false;
  const gridRows = (config.grid && config.grid.rows) || 5;
  const gridCols = (config.grid && config.grid.cols) || 7;
  const showAxisX = Array.isArray(config.axisX);
  const theme = Object.assign({}, DEFAULT_THEME, config.theme);

  const series = (config.series || []).map((s, i) => ({
    name: s.name || `Series ${i + 1}`,
    color: s.color || PALETTE[i % PALETTE.length],
    points: s.points || [],
  }));

  if (!series.length) throw new Error('ProvChart.line: at least one series is required.');

  const n = series[0].points.length;
  if (!n) throw new Error('ProvChart.line: series must have at least one point.');
  const stops = xStops(n);

  function clipPathFor(seriesIndex) {
    const top = stops
      .map((x, i) => `${x}% var(--pc-${id}-s${seriesIndex}-p${i + 1})`)
      .join(', ');
    const bottom = stops
      .slice()
      .reverse()
      .map((x, i) => {
        const pIndex = n - i;
        return `${x}% calc(var(--pc-${id}-s${seriesIndex}-p${pIndex}) + var(--pc-${id}-lw))`;
      })
      .join(', ');
    return `polygon(${top}, ${bottom})`;
  }

  function fillClipPathFor(seriesIndex) {
    const top = stops
      .map((x, i) => `${x}% var(--pc-${id}-s${seriesIndex}-p${i + 1})`)
      .join(', ');
    return `polygon(${top}, 100% 100%, 0% 100%)`;
  }

  const varBlocks = series
    .map((s, i) => pointVarBlock(id, i + 1, s.points, true))
    .join(' ');

  const lineRules = series
    .map((s, i) => {
      const si = i + 1;
      return `
.pc-${id} .pc-line-${si} {
  position: absolute; inset: 0;
  background: ${s.color};
  filter: drop-shadow(0 0 5px ${s.color}88);
  clip-path: ${clipPathFor(si)};
  transition: clip-path 700ms cubic-bezier(.4,0,.2,1);
}
.pc-${id} .pc-fill-${si} {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, ${s.color}33, transparent 70%);
  clip-path: ${fillClipPathFor(si)};
  transition: clip-path 700ms cubic-bezier(.4,0,.2,1);
  opacity: ${config.fill === false ? 0 : 1};
}`;
    })
    .join('\n');

  const gridCss = showGrid
    ? `
.pc-${id} .pc-grid {
  position: absolute; inset: 0;
  background:
    repeating-linear-gradient(to bottom, ${theme.muted} 0, ${theme.muted} 1px, transparent 1px, transparent calc(100% / ${gridRows})),
    repeating-linear-gradient(to right, ${theme.grid} 0, ${theme.grid} 1px, transparent 1px, transparent calc(100% / ${gridCols}));
  opacity: 0.1;
}`
    : '';

  const css = `
.pc-${id} {
  --pc-${id}-lw: ${lineWidth}px;
  ${varBlocks}
  position: relative;
  width: ${width};
  height: ${height}px;
  background: ${theme.surface};
  border-radius: ${theme.radius};
  overflow: hidden;
  font-family: inherit;
}
${gridCss}
${lineRules}
.pc-${id} .pc-axis-x {
  position: absolute; left: 0; right: 0; bottom: 6px;
  display: flex; justify-content: space-between;
  padding-inline: 12px;
  font-size: 11px; color: ${theme.muted};
}`.trim();

  const layers = series
    .map((_, i) => `    <div class="pc-fill-${i + 1}"></div>\n    <div class="pc-line-${i + 1}"></div>`)
    .join('\n');

  const axisHtml = showAxisX
    ? `\n    <div class="pc-axis-x">${config.axisX.map((l) => `<span>${l}</span>`).join('')}</div>`
    : '';

  const html = `<div class="pc-${id}" data-provchart="line">
    <div class="pc-grid"></div>
${layers}${axisHtml}
</div>`;

  return { id, html, css, update: makeLineUpdater(id, series.length) };
}

/** Returns a function: update(seriesIndex, points, el?) writing only CSS vars. */
function makeLineUpdater(id, seriesCount) {
  return function update(seriesIndex, points, el) {
    const target = el || document.querySelector(`.pc-${id}`);
    if (!target) return;
    points.forEach((v, i) => {
      target.style.setProperty(`--pc-${id}-s${seriesIndex}-p${i + 1}`, `${round(100 - clamp(v, 0, 100))}%`);
    });
  };
}

// ------------------------------------------------------------------ //
// Bar chart
// ------------------------------------------------------------------ //

function buildBar(config) {
  const id = config.id || uid('bar');
  const theme = Object.assign({}, DEFAULT_THEME, config.theme);
  const bars = (config.bars || []).map((b, i) => ({
    label: b.label || `Item ${i + 1}`,
    value: clamp(b.value, 0, 100),
    color: b.color || PALETTE[i % PALETTE.length],
  }));

  if (!bars.length) throw new Error('ProvChart.bar: at least one bar is required.');

  const rows = bars
    .map(
      (b, i) => `
    <div class="pc-${id}-row">
      <span class="pc-${id}-label">${b.label}</span>
      <div class="pc-${id}-track">
        <div class="pc-${id}-fill" style="--pc-${id}-v${i}: ${round(b.value)}%; background:${b.color};"></div>
      </div>
      <span class="pc-${id}-val">${round(b.value)}%</span>
    </div>`
    )
    .join('');

  const fillRules = bars
    .map((_, i) => `.pc-${id} .pc-${id}-row:nth-child(${i + 1}) .pc-${id}-fill { width: var(--pc-${id}-v${i}); }`)
    .join('\n');

  const css = `
.pc-${id} { display: flex; flex-direction: column; gap: 12px; font-family: inherit; }
.pc-${id}-row { display: grid; grid-template-columns: 1fr 3fr auto; align-items: center; gap: 10px; }
.pc-${id}-label { font-size: 13px; color: ${theme.text}; }
.pc-${id}-track { height: 8px; border-radius: 999px; background: ${theme.surface}; overflow: hidden; }
.pc-${id}-fill { height: 100%; border-radius: 999px; transition: width 600ms ease; }
.pc-${id}-val { font-size: 12px; color: ${theme.muted}; min-width: 3ch; text-align: right; }
${fillRules}`.trim();

  const html = `<div class="pc-${id}" data-provchart="bar">${rows}\n</div>`;

  return {
    id,
    html,
    css,
    update: function (index, value, el) {
      const target = el || document.querySelector(`.pc-${id}`);
      if (!target) return;
      target.style.setProperty(`--pc-${id}-v${index}`, `${round(clamp(value, 0, 100))}%`);
    },
  };
}

// ------------------------------------------------------------------ //
// Gauge (single value, circular)
// ------------------------------------------------------------------ //

function buildGauge(config) {
  const id = config.id || uid('gauge');
  const theme = Object.assign({}, DEFAULT_THEME, config.theme);
  const value = clamp(config.value, 0, 100);
  const color = config.color || PALETTE[0];
  const size = config.size || 140;
  const thickness = config.thickness || 12;

  const css = `
.pc-${id} {
  --pc-${id}-v: ${round(value)};
  position: relative;
  width: ${size}px; height: ${size}px;
  border-radius: 50%;
  background: conic-gradient(${color} calc(var(--pc-${id}-v) * 1%), ${theme.surface} 0);
  display: grid; place-items: center;
  transition: background 500ms ease;
  font-family: inherit;
}
.pc-${id}::before {
  content: '';
  position: absolute;
  inset: ${thickness}px;
  border-radius: 50%;
  background: ${theme.bg};
}
.pc-${id} .pc-gauge-val {
  position: relative; z-index: 1;
  font-size: ${round(size / 5)}px; font-weight: 700; color: ${theme.text};
}`.trim();

  const html = `<div class="pc-${id}" data-provchart="gauge">
  <span class="pc-gauge-val">${round(value)}%</span>
</div>`;

  return {
    id,
    html,
    css,
    update: function (newValue, el) {
      const target = el || document.querySelector(`.pc-${id}`);
      if (!target) return;
      target.style.setProperty(`--pc-${id}-v`, round(clamp(newValue, 0, 100)));
      const label = target.querySelector('.pc-gauge-val');
      if (label) label.textContent = `${round(clamp(newValue, 0, 100))}%`;
    },
  };
}

// ------------------------------------------------------------------ //
// Stat card
// ------------------------------------------------------------------ //

function buildStat(config) {
  const id = config.id || uid('stat');
  const theme = Object.assign({}, DEFAULT_THEME, config.theme);
  const deltaUp = config.delta && config.delta.trim().startsWith('+');

  const css = `
.pc-${id} {
  background: ${theme.surface};
  border-radius: ${theme.radius};
  padding: 20px;
  display: flex; flex-direction: column; gap: 6px;
  font-family: inherit;
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
}

// ------------------------------------------------------------------ //
// Public API
// ------------------------------------------------------------------ //

export default {
  line: buildLine,
  bar: buildBar,
  gauge: buildGauge,
  stat: buildStat,

  /** Bundle multiple chart outputs into one combined {html, css} pair. */
  combine: function (results) {
    return {
      html: results.map((r) => r.html).join('\n\n'),
      css: results.map((r) => r.css).join('\n\n'),
    };
  },

  _internal: { xStops, slug, uid },
};
