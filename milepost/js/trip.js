/* TRIP — settings that the rest of the app depends on (full planner + recap arrive next). */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { units, ui } = MP;
  const { h, icon } = ui;
  const S = MP.S, E = MP.engine;
  const T = (MP.trip = {});
  let el;
  const num = (label, key, step, hint, scale) => {
    const inp = h('input', { type: 'number', step, value: S.prefs[key] == null ? '' : S.prefs[key], onchange: (e) => { const v = parseFloat(e.target.value); E.setPref(key, isNaN(v) ? null : v); MP.drive && MP.drive.rebuildF(true); } });
    return h('label.field', h('span.k', label), inp, hint ? h('small', hint) : null);
  };
  T.mount = function (root_) {
    el = root_; el.innerHTML = '';
    el.append(h('div.page-head', h('div', h('div.eyebrow', 'Trip'), h('div.page-title', 'Setup'), h('div.sub', 'Tell Milepost about the car and you. The route planner, costs, checklist and recap poster arrive in the next build.'))));
    el.append(h('section.card', h('div.card-h', h('h3', icon('car'), 'Your car')),
      h('div.fields', num('Tank size (gal)', 'tankGal', '0.1'), num('Usual economy (mpg)', 'mpg', '0.5'), num('Fuel price ($/gal)', 'fuelPrice', '0.01'), num('Engine size (L)', 'dispL', '0.1', 'Only used to estimate fuel flow if the car reports no MAF or fuel-rate data'))));
    el.append(h('section.card', h('div.card-h', h('h3', icon('bed'), 'You')),
      h('div.fields', num('You woke up at (hour, 24 h)', 'wakeHour', '0.25', 'Used by the alertness model: hours awake matter a lot on night drives'), num('Typical stop (min)', 'avgStopMin', '1'))));
    const seg = (key, opts) => h('div.seg', opts.map(([v, l]) => h('button' + (S.prefs[key] === v ? '.on' : ''), { onclick: (e) => { E.setPref(key, v); e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); if (key === 'theme') MP.cycleTheme && E.setPref('theme', v); MP.drive && MP.drive.rebuildF(true); } }, l)));
    el.append(h('section.card', h('div.card-h', h('h3', icon('gear'), 'Display')),
      h('div.fields', h('div.field', h('span.k', 'Units'), seg('units', [['imperial', 'Miles'], ['metric', 'Km']])), h('div.field', h('span.k', 'Theme'), seg('theme', [['auto', 'Follow sun'], ['atlas', 'Day'], ['night', 'Night']])), h('div.field', h('span.k', 'Fuel type'), seg('fuelType', [['gasoline', 'Gas'], ['diesel', 'Diesel']])))));
    el.append(h('section.card', h('div.card-h', h('h3', icon('flag'), 'This trip')),
      h('p.muted', S.plan ? (S.plan.from.name + ' → ' + S.plan.to.name) : ''), h('p.muted.small', 'Starter route from the original app. Real roads are fetched automatically when a connection is available and then cached for offline use.'),
      h('button.btn.small.ghost', { onclick: () => { MP.store.remove('plan'); MP.kv.del('route:preset-sh-sewell'); location.reload(); } }, 'Reset trip plan')));
  };
  T.show = function () {};
})(typeof window !== 'undefined' ? window : globalThis);
