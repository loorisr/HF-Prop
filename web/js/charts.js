// Hand-built SVG charts for the path view: band x hour reliability heatmap
// and a 24 h MUF / FOT line chart. Both have hover tooltips.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

const BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5',
  '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

export function relColor(v, dark) {
  const ramp = dark ? BLUE.slice().reverse() : BLUE;
  if (!(v >= 1)) return 'var(--cell-empty)';
  const i = Math.min(ramp.length - 1, Math.round((v / 100) * (ramp.length - 1)));
  return ramp[i];
}

function tooltip(container) {
  let tip = container.querySelector('.tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    container.appendChild(tip);
  }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.style.display = 'block';
      const cw = container.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(cw - tw, x - tw / 2)) + 'px';
      tip.style.top = Math.max(0, y - tip.offsetHeight - 10) + 'px';
    },
    hide() { tip.style.display = 'none'; },
  };
}

/**
 * Heatmap: rows = bands (high freq on top), columns = UTC hours.
 * data[h][b] = result object (or null).
 */
export function drawHeatmap(container, { bands, data, hour, dark, onPickHour }) {
  container.querySelector('svg')?.remove();
  const W = Math.max(300, container.clientWidth || 640), cell = W < 480 ? 18 : 22, padL = 40, padT = 6, padB = 22;
  const rows = bands.length;
  const cw = (W - padL - 4) / 24;
  const H = padT + rows * cell + padB;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
    'aria-label': 'Reliability by band and UTC hour' });
  const tip = tooltip(container);
  for (let r = 0; r < rows; r++) {
    const b = rows - 1 - r; // highest band first
    const y = padT + r * cell;
    el('text', { x: padL - 8, y: y + cell / 2 + 4, class: 'axis-label', 'text-anchor': 'end' }, svg).textContent = bands[b].name;
    for (let h = 0; h < 24; h++) {
      const res = data[h][b];
      const v = res ? res.rel : NaN;
      const rect = el('rect', {
        x: padL + h * cw + 1, y: y + 1, width: cw - 2, height: cell - 2, rx: 2,
        fill: relColor(v, dark), class: 'cell',
      }, svg);
      rect.addEventListener('pointerenter', (ev) => {
        const box = container.getBoundingClientRect();
        const rr = rect.getBoundingClientRect();
        tip.show(`<b>${bands[b].name} · ${String(h).padStart(2, '0')}:00 UTC</b><br>` +
          (res ? `Reliability ${res.rel.toFixed(0)}%<br>SNR ${res.snr.toFixed(0)} dB<br>MUF ${res.muf50.toFixed(1)} MHz` : 'no result'),
          rr.left - box.left + rr.width / 2, rr.top - box.top);
      });
      rect.addEventListener('pointerleave', () => tip.hide());
      rect.addEventListener('click', () => onPickHour?.(h));
    }
  }
  // selected hour outline
  el('rect', { x: padL + hour * cw, y: padT - 1, width: cw, height: rows * cell + 2, rx: 3,
    class: 'hour-sel' }, svg);
  for (let h = 0; h < 24; h += 3) {
    el('text', { x: padL + h * cw + cw / 2, y: H - 6, class: 'axis-label', 'text-anchor': 'middle' }, svg)
      .textContent = String(h).padStart(2, '0');
  }
  container.prepend(svg);
}

/** Line chart of MUF (median) and FOT (90 % of days) over 24 h, MHz. */
export function drawMufChart(container, { mufs, fots, hour, bands }) {
  container.querySelector('svg')?.remove();
  const W = Math.max(300, container.clientWidth || 640), H = W < 480 ? 180 : 200, padL = 36, padR = 40, padT = 10, padB = 24;
  const valid = [...mufs, ...fots].filter(Number.isFinite);
  const yMax = Math.max(10, Math.ceil((Math.max(...valid, 0) + 2) / 5) * 5);
  const x = (h) => padL + (h / 23) * (W - padL - padR);
  const y = (v) => padT + (1 - v / yMax) * (H - padT - padB);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
    'aria-label': 'MUF and FOT over 24 hours' });

  for (let v = 0; v <= yMax; v += 5) {
    el('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: 'grid' }, svg);
    el('text', { x: padL - 8, y: y(v) + 4, class: 'axis-label', 'text-anchor': 'end' }, svg).textContent = v;
  }
  // band reference ticks on the right edge
  let lastY = Infinity;
  for (const b of bands) {
    if (b.f > yMax || lastY - y(b.f) < 12) continue;
    lastY = y(b.f);
    el('text', { x: W - padR + 6, y: y(b.f) + 3, class: 'axis-label faint' }, svg).textContent = b.name;
  }
  for (let h = 0; h < 24; h += 3) {
    el('text', { x: x(h), y: H - 6, class: 'axis-label', 'text-anchor': 'middle' }, svg).textContent = String(h).padStart(2, '0');
  }
  el('line', { x1: x(hour), x2: x(hour), y1: padT, y2: H - padB, class: 'hour-line' }, svg);

  const path = (vals) => vals.map((v, h) => (Number.isFinite(v) ? `${h === 0 || !Number.isFinite(vals[h - 1]) ? 'M' : 'L'}${x(h).toFixed(1)},${y(v).toFixed(1)}` : '')).join('');
  el('path', { d: path(mufs), class: 'series s1' }, svg);
  el('path', { d: path(fots), class: 'series s2' }, svg);
  // direct labels at the right end of each line
  const lastM = mufs[23], lastF = fots[23];
  if (Number.isFinite(lastM)) el('text', { x: x(23) - 4, y: y(lastM) - 6, class: 'direct-label', 'text-anchor': 'end' }, svg).textContent = 'MUF';
  if (Number.isFinite(lastF)) el('text', { x: x(23) - 4, y: y(lastF) + 14, class: 'direct-label', 'text-anchor': 'end' }, svg).textContent = 'FOT';

  // hover crosshair
  const cross = el('line', { y1: padT, y2: H - padB, class: 'crosshair', visibility: 'hidden' }, svg);
  const dotM = el('circle', { r: 4, class: 'dot s1', visibility: 'hidden' }, svg);
  const dotF = el('circle', { r: 4, class: 'dot s2', visibility: 'hidden' }, svg);
  const hit = el('rect', { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: 'transparent' }, svg);
  const tip = tooltip(container);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const h = Math.max(0, Math.min(23, Math.round(((sx - padL) / (W - padL - padR)) * 23)));
    cross.setAttribute('x1', x(h)); cross.setAttribute('x2', x(h)); cross.setAttribute('visibility', 'visible');
    for (const [d, v] of [[dotM, mufs[h]], [dotF, fots[h]]]) {
      if (Number.isFinite(v)) { d.setAttribute('cx', x(h)); d.setAttribute('cy', y(v)); d.setAttribute('visibility', 'visible'); }
      else d.setAttribute('visibility', 'hidden');
    }
    const box = container.getBoundingClientRect();
    tip.show(`<b>${String(h).padStart(2, '0')}:00 UTC</b><br><span class="key s1"></span>MUF ${fmt(mufs[h])} MHz<br><span class="key s2"></span>FOT ${fmt(fots[h])} MHz`,
      (x(h) / W) * r.width + (r.left - box.left), (padT / H) * r.height + (r.top - box.top) + 30);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => { tip.hide(); [cross, dotM, dotF].forEach((e) => e.setAttribute('visibility', 'hidden')); });
  container.prepend(svg);
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
