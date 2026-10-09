/* Plain-English diagnostic trouble code (DTC) lookup.
 * Generic (SAE J2012) powertrain codes plus a handful of common chassis/body/network ones.
 * Anything not listed falls back to a description of its system from the code's structure.
 * Guidance text is general advice, not a repair diagnosis. */
(function (root) {
  'use strict';
  const MP = (root.MP = root.MP || {});

  const DB = {
    P0010: 'Intake cam position actuator circuit (bank 1)', P0011: 'Intake cam timing over-advanced (bank 1)',
    P0012: 'Intake cam timing over-retarded (bank 1)', P0014: 'Exhaust cam timing over-advanced (bank 1)',
    P0016: 'Crankshaft / camshaft position correlation (bank 1 sensor A)', P0030: 'O2 sensor heater control circuit (bank 1 sensor 1)',
    P0036: 'O2 sensor heater control circuit (bank 1 sensor 2)', P0087: 'Fuel rail pressure too low', P0088: 'Fuel rail pressure too high',
    P0100: 'Mass airflow (MAF) sensor circuit', P0101: 'MAF sensor range / performance', P0102: 'MAF sensor circuit low', P0103: 'MAF sensor circuit high',
    P0106: 'MAP sensor range / performance', P0107: 'MAP sensor circuit low', P0108: 'MAP sensor circuit high',
    P0112: 'Intake air temperature sensor circuit low', P0113: 'Intake air temperature sensor circuit high',
    P0116: 'Coolant temperature sensor range / performance', P0117: 'Coolant temperature sensor circuit low', P0118: 'Coolant temperature sensor circuit high',
    P0120: 'Throttle / pedal position sensor A circuit', P0121: 'Throttle position sensor range / performance', P0122: 'Throttle position sensor circuit low', P0123: 'Throttle position sensor circuit high',
    P0125: 'Coolant too cool for closed-loop fuel control', P0128: 'Coolant thermostat (running below regulating temperature)',
    P0130: 'O2 sensor circuit (bank 1 sensor 1)', P0131: 'O2 sensor circuit low voltage (bank 1 sensor 1)', P0132: 'O2 sensor circuit high voltage (bank 1 sensor 1)',
    P0133: 'O2 sensor slow response (bank 1 sensor 1)', P0134: 'O2 sensor no activity (bank 1 sensor 1)', P0135: 'O2 sensor heater circuit (bank 1 sensor 1)',
    P0137: 'O2 sensor circuit low voltage (bank 1 sensor 2)', P0138: 'O2 sensor circuit high voltage (bank 1 sensor 2)', P0141: 'O2 sensor heater circuit (bank 1 sensor 2)',
    P0150: 'O2 sensor circuit (bank 2 sensor 1)', P0153: 'O2 sensor slow response (bank 2 sensor 1)', P0155: 'O2 sensor heater circuit (bank 2 sensor 1)',
    P0171: 'Fuel system too lean (bank 1)', P0172: 'Fuel system too rich (bank 1)', P0174: 'Fuel system too lean (bank 2)', P0175: 'Fuel system too rich (bank 2)',
    P0191: 'Fuel rail pressure sensor range / performance', P0200: 'Fuel injector circuit',
    P0201: 'Injector circuit, cylinder 1', P0202: 'Injector circuit, cylinder 2', P0203: 'Injector circuit, cylinder 3', P0204: 'Injector circuit, cylinder 4',
    P0205: 'Injector circuit, cylinder 5', P0206: 'Injector circuit, cylinder 6', P0207: 'Injector circuit, cylinder 7', P0208: 'Injector circuit, cylinder 8',
    P0217: 'Engine over-temperature condition', P0218: 'Transmission over-temperature condition', P0230: 'Fuel pump primary circuit',
    P0300: 'Random / multiple cylinder misfire', P0301: 'Cylinder 1 misfire', P0302: 'Cylinder 2 misfire', P0303: 'Cylinder 3 misfire', P0304: 'Cylinder 4 misfire',
    P0305: 'Cylinder 5 misfire', P0306: 'Cylinder 6 misfire', P0307: 'Cylinder 7 misfire', P0308: 'Cylinder 8 misfire',
    P0315: 'Crankshaft position system variation not learned', P0325: 'Knock sensor 1 circuit', P0327: 'Knock sensor 1 circuit low',
    P0335: 'Crankshaft position sensor A circuit', P0336: 'Crankshaft position sensor range / performance', P0340: 'Camshaft position sensor circuit', P0341: 'Camshaft position sensor range / performance',
    P0351: 'Ignition coil A circuit', P0352: 'Ignition coil B circuit', P0353: 'Ignition coil C circuit', P0354: 'Ignition coil D circuit',
    P0355: 'Ignition coil E circuit', P0356: 'Ignition coil F circuit', P0357: 'Ignition coil G circuit', P0358: 'Ignition coil H circuit',
    P0401: 'EGR flow insufficient', P0402: 'EGR flow excessive', P0403: 'EGR control circuit', P0404: 'EGR range / performance', P0405: 'EGR sensor A circuit low',
    P0420: 'Catalyst efficiency below threshold (bank 1)', P0430: 'Catalyst efficiency below threshold (bank 2)',
    P0440: 'Evaporative emission (EVAP) system', P0441: 'EVAP incorrect purge flow', P0442: 'EVAP small leak detected', P0443: 'EVAP purge control valve circuit',
    P0446: 'EVAP vent control circuit', P0449: 'EVAP vent valve circuit', P0450: 'EVAP pressure sensor circuit', P0452: 'EVAP pressure sensor low', P0453: 'EVAP pressure sensor high',
    P0455: 'EVAP large leak detected (check the gas cap)', P0456: 'EVAP very small leak detected', P0457: 'EVAP leak (fuel cap may be loose)',
    P0460: 'Fuel level sensor circuit', P0461: 'Fuel level sensor range / performance', P0462: 'Fuel level sensor circuit low', P0463: 'Fuel level sensor circuit high',
    P0480: 'Cooling fan 1 control circuit', P0481: 'Cooling fan 2 control circuit', P0500: 'Vehicle speed sensor', P0501: 'Vehicle speed sensor range / performance',
    P0505: 'Idle control system', P0506: 'Idle speed lower than expected', P0507: 'Idle speed higher than expected',
    P0520: 'Engine oil pressure sensor circuit', P0521: 'Engine oil pressure sensor range / performance', P0522: 'Engine oil pressure low', P0523: 'Engine oil pressure high',
    P0562: 'System voltage low', P0563: 'System voltage high', P0571: 'Brake switch circuit',
    P0600: 'Serial communication link', P0601: 'Control module memory checksum error', P0603: 'Control module keep-alive memory error', P0606: 'Control module processor fault',
    P0620: 'Generator control circuit', P0627: 'Fuel pump control circuit', P0630: 'VIN not programmed',
    P0700: 'Transmission control system', P0705: 'Transmission range sensor circuit', P0715: 'Input / turbine speed sensor circuit', P0720: 'Output speed sensor circuit',
    P0730: 'Incorrect gear ratio', P0741: 'Torque converter clutch stuck off', P0750: 'Shift solenoid A', P0755: 'Shift solenoid B',
    P2096: 'Post-catalyst fuel trim too lean (bank 1)', P2097: 'Post-catalyst fuel trim too rich (bank 1)', P2135: 'Throttle position sensors A/B correlation',
    P2138: 'Pedal position sensors D/E correlation', P2187: 'System too lean at idle (bank 1)', P2188: 'System too rich at idle (bank 1)',
    P2195: 'O2 sensor signal stuck lean (bank 1 sensor 1)', P2196: 'O2 sensor signal stuck rich (bank 1 sensor 1)', P2A00: 'O2 sensor range / performance (bank 1 sensor 1)',
    U0100: 'Lost communication with engine control module', U0101: 'Lost communication with transmission control module', U0121: 'Lost communication with ABS module',
    U0140: 'Lost communication with body control module', C0031: 'Left front wheel speed sensor circuit', C0034: 'Right front wheel speed sensor circuit',
    C0037: 'Left rear wheel speed sensor circuit', C0040: 'Right rear wheel speed sensor circuit', B0001: 'Driver frontal airbag deployment control',
  };

  const SYSTEMS = [
    [/^P0[0-2]/, 'Fuel & air metering'], [/^P03/, 'Ignition / misfire'], [/^P04/, 'Emission controls'], [/^P05/, 'Speed, idle & auxiliary inputs'],
    [/^P06/, 'Computer & output circuits'], [/^P0[78]/, 'Transmission'], [/^P1/, 'Manufacturer-specific powertrain'], [/^P2/, 'Fuel & air metering (generic)'],
    [/^P3/, 'Powertrain (generic / manufacturer)'], [/^C/, 'Chassis (brakes, steering, suspension)'], [/^B/, 'Body (airbags, comfort)'], [/^U/, 'Network communication'],
  ];

  // advice classes: 'stop' = pull over, 'soon' = get it checked soon, 'ok' = generally safe to continue
  function severity(code) {
    if (/^P0(217|218|52[0-3]|562)$/.test(code)) return 'stop';   // overheating, oil pressure, system voltage
    if (/^P0(44[0-9]|45[0-7]|420|430)$/.test(code)) return 'ok'; // EVAP leaks, catalyst efficiency
    return 'soon';
  }
  const ADVICE = {
    stop: 'Serious: stop somewhere safe and check temperature / oil / voltage before continuing.',
    soon: 'Get this checked soon. The car may be fine to drive meanwhile — keep an eye on the gauges.',
    ok: 'Usually not urgent for a trip (emissions-related) — check the gas cap and get it looked at when convenient.',
  };

  MP.dtc = {
    describe(code) {
      code = String(code || '').toUpperCase();
      const sys = (SYSTEMS.find(([re]) => re.test(code)) || [0, 'Vehicle system'])[1];
      let text = DB[code];
      if (!text) text = /^P[1-3]/.test(code) && code[1] === '1' ? 'Manufacturer-specific code — look it up for your make/model' : sys + ' fault (code ' + code + ')';
      const sev = severity(code);
      return { code, text, system: sys, severity: sev, advice: ADVICE[sev] };
    },
    decode(a, b) {
      const letter = 'PCBU'[a >> 6];
      return letter + ((a >> 4) & 3) + (a & 15).toString(16).toUpperCase() + (b >> 4).toString(16).toUpperCase() + (b & 15).toString(16).toUpperCase();
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MP.dtc;
})(typeof window !== 'undefined' ? window : globalThis);
