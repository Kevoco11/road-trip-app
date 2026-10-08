/* Trip plans. The built-in starter plan is the trip from the original app
 * (Sterling Heights, MI → Sewell, NJ); any other trip is planned from the Trip tab.
 * The straight-line waypoints below are only an honest, clearly-labelled fallback used when
 * no routing service has ever been reachable. Real roads come from the router and are cached. */
(function (root) {
  'use strict';
  const MP = root.MP;

  const FALLBACK_WAYPOINTS = [
    { lat: 42.6167, lng: -83.0462, name: 'Sterling Heights' },
    { lat: 41.6528, lng: -83.5379, name: 'Toledo / OH Turnpike' },
    { lat: 41.1, lng: -80.65, name: 'Youngstown' },
    { lat: 41.0, lng: -80.5186, name: 'PA Turnpike entry' },
    { lat: 40.0167, lng: -78.0833, name: 'Sideling Hill Plaza' },
    { lat: 39.9056, lng: -75.1294, name: 'Walt Whitman Bridge' },
    { lat: 39.7662, lng: -75.0972, name: 'Sewell, NJ' },
  ];

  function nextDeparture(hour, min) {
    const d = new Date(); d.setHours(hour, min, 0, 0);
    if (d.getTime() < Date.now() - 30 * 60000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const plan = {
    FALLBACK_WAYPOINTS,
    nextDeparture,
    preset() {
      return {
        id: 'preset-sh-sewell',
        from: { name: 'Sterling Heights, MI', lat: 42.6167, lng: -83.0462 },
        to: { name: 'Sewell, NJ', lat: 39.7662, lng: -75.0972 },
        via: [],
        departMs: nextDeparture(16, 30),
        notBeforeMs: null, // optional: "don't arrive before" (e.g. hosts asleep)
        stops: [
          { id: 's1', name: 'Youngstown fuel stop', lat: 41.1, lng: -80.65, minutes: 12, kind: 'fuel' },
          { id: 's2', name: 'Sideling Hill service plaza', lat: 40.0167, lng: -78.0833, minutes: 15, kind: 'rest' },
        ],
        costs: [
          { id: 'c1', label: 'PA Turnpike (toll-by-plate)', amt: 121.73, kind: 'toll' },
          { id: 'c2', label: 'Walt Whitman Bridge (cash)', amt: 5.0, kind: 'toll' },
        ],
      };
    },
    defaultChecklist() {
      return [
        { id: 'k1', text: 'Bring $10–$20 cash for the Walt Whitman Bridge toll', done: false },
        { id: 'k2', text: 'Pack bags into the car before work', done: false },
        { id: 'k3', text: 'Plug the Veepeak OBD-II dongle into the car', done: false },
        { id: 'k4', text: 'Set tire pressures to the cold PSI on the door placard', done: false },
        { id: 'k5', text: 'Confirm your plate is registered for PA Turnpike toll-by-plate', done: false },
      ];
    },
    /** human name for a place from a geocoder result */
    shortName(r) {
      const a = r.address || {};
      const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
      const st = a.state_code || a['ISO3166-2-lvl4'] && a['ISO3166-2-lvl4'].split('-')[1] || a.state || '';
      return city ? (st ? city + ', ' + st : city) : (r.display_name || '').split(',').slice(0, 2).join(',').trim();
    },
  };
  MP.plan = plan;
})(typeof window !== 'undefined' ? window : globalThis);
