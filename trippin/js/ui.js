/* Trippin' UI helpers: DOM builder, icons, toasts, modal sheet. */
(function (root) {
  'use strict';
  const MP = (root.MP = root.MP || {});
  const doc = root.document;
  const SVGNS = 'http://www.w3.org/2000/svg';

  /** h('div.card#id', {onclick, dataset:{}}, child, ...)  — children may be strings (text), nodes, arrays or null */
  function h(sel, props, ...kids) {
    const m = /^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i.exec(sel) || [];
    const el = doc.createElement(m[1] || 'div');
    (m[2] || '').replace(/([.#])([\w-]+)/g, (_, k, v) => { if (k === '.') el.classList.add(v); else el.id = v; return ''; });
    if (props && (props.nodeType || typeof props === 'string' || Array.isArray(props))) { kids.unshift(props); props = null; }
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') v.split(' ').forEach((c) => c && el.classList.add(c));
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') el.innerHTML = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(c.nodeType ? c : doc.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }

  function svgEl(tag, attrs) {
    const el = doc.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
    return el;
  }

  /** <svg><use href="#i-name"/></svg> */
  function icon(name, cls) {
    const s = svgEl('svg', { class: 'i ' + (cls || ''), 'aria-hidden': 'true' });
    const u = svgEl('use', { href: '#i-' + name });
    s.appendChild(u);
    return s;
  }

  function iconHTML(name, cls) { return '<svg class="i ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }

  function $(sel, rootEl) { return (rootEl || doc).querySelector(sel); }
  function $$(sel, rootEl) { return Array.from((rootEl || doc).querySelectorAll(sel)); }

  /* ------------------------------------------------------------------ toast */
  function toast(msg, kind, ms) {
    const host = $('#toasts');
    if (!host) return;
    const t = h('div.toast.' + (kind || 'info'), { role: 'status' }, msg);
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms || 3200);
    while (host.children.length > 3) host.firstChild.remove();
  }

  /* ------------------------------------------------------------------ modal */
  /** openSheet({title, body:Node, actions:[{label, kind, onClick}], onClose}) → {close()} */
  function openSheet(opts) {
    const host = $('#modal-root');
    const back = h('div.scrim');
    const body = h('div.msheet-body', opts.body);
    const head = h('div.msheet-head', h('h3', opts.title || ''), h('button.icon-btn', { 'aria-label': 'Close', onclick: () => api.close() }, icon('x')));
    const actions = opts.actions && opts.actions.length
      ? h('div.msheet-actions', opts.actions.map((a) => h('button.btn' + (a.kind ? '.' + a.kind : ''), { onclick: () => { if (a.onClick) a.onClick(api); if (!a.keepOpen) api.close(); } }, a.label)))
      : null;
    const sheet = h('div.msheet', { role: 'dialog', 'aria-modal': 'true' }, h('div.sheet-grab'), head, body, actions);
    const wrap = h('div.modal', back, sheet);
    host.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('in'));
    const api = {
      el: sheet, body,
      close() {
        wrap.classList.remove('in');
        setTimeout(() => wrap.remove(), 260);
        if (opts.onClose) opts.onClose();
      },
    };
    back.addEventListener('click', () => api.close());
    return api;
  }

  function confirmSheet(title, text, okLabel, kind) {
    return new Promise((resolve) => {
      let done = false;
      openSheet({
        title, body: h('p.muted', text),
        actions: [
          { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
          { label: okLabel || 'OK', kind: kind || 'primary', onClick: () => { done = true; resolve(true); } },
        ],
        onClose: () => { if (!done) resolve(false); },
      });
    });
  }

  /* --------------------------------------------------------------- misc */
  /** animate a number element textContent */
  function setText(el, txt) { if (el && el.textContent !== String(txt)) el.textContent = txt; }
  function setHidden(el, hidden) { if (el) el.hidden = !!hidden; }
  function css(name) { return getComputedStyle(doc.documentElement).getPropertyValue(name).trim(); }

  /* ------------------------------------------------------- split-flap display */
  // flap(host, "2:07") updates a split-flap board; only the characters that change flip.
  function flapCell(ch) {
    const half = (cls, c) => h('div.h.' + cls, h('span', c));
    const el = h('div.fl' + (ch === ':' ? '.colon' : ''), half('top', ch), half('bot', ch));
    return { el, ch, top: el.children[0].firstChild, bot: el.children[1].firstChild };
  }
  function flapSet(cell, ch, animate) {
    if (cell.ch === ch) return;
    const old = cell.ch; cell.ch = ch;
    cell.top.textContent = ch;
    if (!animate || ch === ':' || old === ':') { cell.bot.textContent = ch; return; }
    const ft = h('div.h.top.ft', h('span', old)), fb = h('div.h.bot.fb', h('span', ch));
    cell.el.append(ft, fb);
    setTimeout(() => { cell.bot.textContent = ch; ft.remove(); fb.remove(); }, 380);
  }
  function flap(host, text) {
    if (host._v === text) return;
    const chars = Array.from(text);
    if (!host._cells || host._cells.length !== chars.length) {
      host.replaceChildren(); host._cells = chars.map((c) => { const cell = flapCell(c); host.appendChild(cell.el); return cell; });
      host._v = text; return;
    }
    host._v = text;
    chars.forEach((c, i) => flapSet(host._cells[i], c, true));
  }

  /* ------------------------------------------------------- road-sign shields */
  let shieldN = 0;
  const SHIELD_I = 'M20 1.4c4.6 2.5 11.2 3.6 18.4 2.4.8 5 .6 10.2-.5 15.6C36 30 29.6 38.2 20 42.8 10.4 38.2 4 30 2.1 19.4 1 14 .8 8.8 1.6 3.8 8.8 5 15.4 3.9 20 1.4Z';
  /** route shield for "I 80", "US 30", "PA 66"… (Interstate / US route / state route) */
  function shield(ref, px) {
    const m = /^([A-Za-z]{1,3})[\s-]*([0-9A-Za-z]+)/.exec(String(ref || '').split(';')[0].trim());
    const pre = m ? m[1].toUpperCase() : '', num = m ? m[2] : String(ref || '').slice(0, 3);
    const s = svgEl('svg', { viewBox: '0 0 40 44', class: 'shield', width: px || 30, height: (px || 30) * 1.1 });
    const txt = (fill, size) => { const t = svgEl('text', { x: 20, y: pre === 'I' ? 30.5 : 27.5, 'text-anchor': 'middle', fill, 'font-family': 'Barlow Condensed, sans-serif', 'font-weight': 800, 'font-size': num.length > 2 ? size - 3 : size }); t.textContent = num; return t; };
    if (pre === 'I') {
      const id = 'shc' + (shieldN++), defs = svgEl('defs'), cp = svgEl('clipPath', { id });
      cp.appendChild(svgEl('path', { d: SHIELD_I, transform: 'translate(20 22) scale(.86) translate(-20 -22)' })); defs.appendChild(cp); s.appendChild(defs);
      s.appendChild(svgEl('path', { d: SHIELD_I, fill: '#fff' }));
      const g = svgEl('g', { 'clip-path': 'url(#' + id + ')' });
      g.appendChild(svgEl('rect', { x: 0, y: 0, width: 40, height: 44, fill: '#1d4aa0' })); g.appendChild(svgEl('rect', { x: 0, y: 0, width: 40, height: 14.5, fill: '#c8102e' }));
      s.appendChild(g); s.appendChild(txt('#fff', 19));
    } else if (pre === 'US') {
      s.appendChild(svgEl('path', { d: SHIELD_I, fill: '#fff', stroke: '#111', 'stroke-width': 2.4, 'stroke-linejoin': 'round' })); s.appendChild(txt('#111', 18));
    } else {
      s.appendChild(svgEl('rect', { x: 3.5, y: 6, width: 33, height: 32, rx: 10, fill: '#fff', stroke: '#111', 'stroke-width': 2.4 })); s.appendChild(txt('#111', 17));
    }
    return s;
  }

  const api = { h, svgEl, icon, iconHTML, $, $$, toast, openSheet, confirmSheet, setText, setHidden, css, flap, shield };
  MP.ui = api;
})(typeof window !== 'undefined' ? window : globalThis);
