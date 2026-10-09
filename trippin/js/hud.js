/* HUD — a bare, high-contrast speed and next-turn display for a phone lying on the dash.
 * "Reflect" mode flips the picture upside-down so it reads correctly when it reflects off the windshield;
 * "Mirror" flips left-right; "Normal" is for a phone in a mount. */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { units, fmt, ui } = MP;
  const { h, icon } = ui;
  const S = MP.S;
  const H = (MP.hud = {});
  const doc = root.document;
  const MODES = [['reflectV', 'Reflect'], ['mirrorH', 'Mirror'], ['normal', 'Normal']];
  let host, nodes = {}, off = null, open = false;

  function build() {
    host = doc.getElementById('hud');
    nodes.speed = h('div.hud-speed', '0'); nodes.unit = h('div.hud-unit', 'mph');
    nodes.turnIc = h('div.hud-ic', icon('arrow', 'turn')); nodes.turnDist = h('div.hud-dist', ''); nodes.turnTxt = h('div.hud-txt', '');
    nodes.eta = h('div.hud-eta', ''); nodes.alert = h('div.hud-alert', '');
    nodes.face = h('div.hud-face', h('div.hud-turn', nodes.turnIc, h('div', nodes.turnDist, nodes.turnTxt)), h('div.hud-mid', nodes.speed, nodes.unit), h('div.hud-foot', nodes.eta, nodes.alert));
    nodes.close = h('button.icon-btn.hud-x', { 'aria-label': 'Close HUD', onclick: () => H.close() }, icon('x'));
    nodes.mode = h('button.btn.small.hud-mode', { onclick: () => { const i = MODES.findIndex((m) => m[0] === S.prefs.hudMode); MP.engine.setPref('hudMode', MODES[(i + 1) % MODES.length][0]); apply(); } }, '');
    host.replaceChildren(nodes.face, nodes.close, nodes.mode);
  }
  function apply() {
    const m = S.prefs.hudMode || 'reflectV';
    nodes.face.dataset.mode = m;
    nodes.mode.textContent = (MODES.find((x) => x[0] === m) || MODES[0])[1];
  }
  function update(d) {
    ui.setText(nodes.speed, units.speed(d.speedMps)); ui.setText(nodes.unit, units.speedUnit());
    const stp = d.nextStep, r = S.route;
    const show = !!(S.trip && stp && r);
    nodes.face.querySelector('.hud-turn').style.visibility = show ? 'visible' : 'hidden';
    if (show) {
      const ic = MP.Route.stepIcon(stp), svg = nodes.turnIc.querySelector('svg');
      svg.firstChild.setAttribute('href', '#i-' + ic.icon); svg.style.transform = 'rotate(' + ic.rot + 'deg)';
      ui.setText(nodes.turnDist, d.stepDistM != null ? units.distLabel(d.stepDistM) : ''); ui.setText(nodes.turnTxt, stp.text);
    }
    ui.setText(nodes.eta, r && d.etaMs ? 'ARRIVE ' + fmt.clock(d.etaMs) + ' · ' + units.dist(d.remaining) + ' ' + units.distUnit() : (S.trip ? 'FREE DRIVE · ' + units.dist(S.trip.distM) + ' ' + units.distUnit() : ''));
    const a = d.alert, bits = [];
    if (a) bits.push('ALERT ' + a.score + '%');
    if (d.fuel && d.fuel.rangeM != null) bits.push('RANGE ' + units.dist(d.fuel.rangeM) + ' ' + units.distUnit());
    ui.setText(nodes.alert, bits.join('  ·  '));
    nodes.alert.dataset.level = a ? a.level : '';
  }
  H.open = function () {
    if (!host) build();
    apply(); host.hidden = false; open = true;
    if (!off) off = MP.bus.on('tick', (d) => { if (open) update(d); });
    update(S.d);
    if (MP.wake) MP.wake.request();
  };
  H.close = function () {
    if (host) host.hidden = true;
    open = false;
    if (!S.trip && MP.wake) MP.wake.release();
  };
  H.isOpen = () => open;
  if (MP.native) MP.native.on('back', () => { if (open) H.close(); });
})(typeof window !== 'undefined' ? window : globalThis);
