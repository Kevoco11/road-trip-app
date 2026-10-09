/* Trip plans. There is no built-in trip: you plan one in the Trip tab (any two places), or just start a free drive.
 *
 * plan = { id, from:{name,lat,lng}, to:{...}, via:[{...}], departMs, notBeforeMs, avoidTolls,
 *          stops:[{id,name,lat,lng,minutes,kind}], costs:[{id,label,amt,kind}] }
 */
(function (root) {
  'use strict';
  const MP = root.MP;

  /** next occurrence of hour:min (today if it's still within 30 min of now, else tomorrow) */
  function nextDeparture(hour, min) {
    const d = new Date(); d.setHours(hour, min, 0, 0);
    if (d.getTime() < Date.now() - 30 * 60000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const plan = {
    nextDeparture,
    /** a new plan between two places ({name,lat,lng}); departs 15 min from now by default */
    blank(from, to) {
      const p = (x) => ({ name: x.name, lat: x.lat, lng: x.lng });
      return {
        id: 'p' + MP.util.uid(), from: p(from), to: p(to), via: [], departMs: Math.ceil((Date.now() + 15 * 60000) / 300000) * 300000,
        notBeforeMs: null, avoidTolls: false, stops: [], costs: [],
      };
    },
    /** a sensible pre-drive checklist for any trip */
    defaultChecklist() {
      return [
        { id: 'k1', text: 'Fuel level or charge is enough for the first leg', done: false },
        { id: 'k2', text: 'Tire pressures match the door placard (check cold)', done: false },
        { id: 'k3', text: 'Phone mount and charger are in the car', done: false },
        { id: 'k4', text: 'OBD-II adapter plugged in (optional, for the Car tab)', done: false },
        { id: 'k5', text: 'Cash or toll transponder ready for toll roads', done: false },
        { id: 'k6', text: 'Water, snacks and a sweater within reach', done: false },
        { id: 'k7', text: 'Know where you will stop if you get tired', done: false },
      ];
    },
    /** human name for a place from a Nominatim result */
    shortName(r) {
      const a = r.address || {};
      const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
      const st = (a['ISO3166-2-lvl4'] && a['ISO3166-2-lvl4'].split('-')[1]) || a.state_code || a.state || '';
      const road = a.road && (a.house_number ? a.house_number + ' ' : '') + a.road;
      const head = r.name && r.name !== city ? r.name : road || city;
      if (!head) return (r.display_name || '').split(',').slice(0, 2).join(',').trim();
      const tail = city && head !== city ? city : '';
      return [head, tail, st].filter(Boolean).join(', ');
    },
  };
  MP.plan = plan;
  if (typeof module !== 'undefined' && module.exports) module.exports = plan;
})(typeof window !== 'undefined' ? window : globalThis);
