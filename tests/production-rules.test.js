const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { overtimeDays, overtimeMinutes, shiftMinutesFor, readEntry, dayStart, dayKey, toMinutes, performanceFlags, configureShifts, shiftSettings, readShiftSettings } = require('../production-rules');

test('configured shift duration supplies catalogue target labels', () => {
  // The floor's own figures: 12 hours less an hour of breaks is 11, and
  // 8 hours 30 less the same hour is 7 hours 30.
  assert.equal(shiftMinutesFor({ gender: 'Male' }), 660);
  assert.equal(shiftMinutesFor({ gender: 'Female' }), 450);
});
test('rejects impossible calendars, invalid clock values, negative/fractional input and coercion', () => {
  for (const date of ['2026-02-29', '2026-13-01', '2026-10-05T00:00:00Z', '05/10/2026']) assert.throws(() => dayStart(date));
  for (const time of ['24:00', '09:60', '9:30', '09:30junk']) assert.throws(() => toMinutes(time));
  for (const pieces of [-1, 1.2, '12', null, Number.POSITIVE_INFINITY]) assert.throws(() => readEntry({ labourId: 'w', toyId: 't', processId: 'p', minutes: 60, pieces }));
  for (const minutes of [0, -1, 1.5, '60', 1441]) assert.throws(() => readEntry({ labourId: 'w', toyId: 't', processId: 'p', minutes, pieces: 0 }));
});
test('calendar markers remain the same in UTC, IST and US timezones', () => {
  assert.equal(dayKey(dayStart('2026-10-05')), '2026-10-05');
  const script = `const r=require(${JSON.stringify(require.resolve('../production-rules'))});process.stdout.write(r.dayStart('2026-10-05').toISOString())`;
  for (const TZ of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stdout, '2026-10-05T00:00:00.000Z');
  }
});
test('flags use only prior weighted days of the same worker, toy and process', () => {
  const row = (date, pieces, minutes = 60, overrides = {}) => ({ date: dayStart(date), labourId: 'w', toyId: 't', processId: 'p', pieces, minutes, ...overrides });
  const rows = [row('2026-10-01', 100), row('2026-10-02', 100, 120), row('2026-10-03', 30), row('2026-10-04', 1e6), row('2026-10-01', 1e6, 60, { processId: 'other' }), row('2026-10-01', 1e6, 60, { labourId: 'other' })];
  const flags = performanceFlags(rows);
  assert.equal(flags.length, 1); assert.equal(flags[0].date, '2026-10-03'); assert.equal(flags[0].usualRate, 66.7); assert.equal(flags[0].baselineDays, 2);
  assert.deepEqual(performanceFlags([row('2026-10-01', 100), row('2026-10-02', 50)]), []);
  assert.equal(performanceFlags([row('2026-10-01', 100), row('2026-10-02', 20, 30), row('2026-10-02', 30, 30)]).length, 0);
});

test('shift and break times come from settings, and a break only counts if it falls in the hours worked', t => {
  t.after(() => configureShifts(null));

  // Leaving before lunch must not have lunch deducted.

  const changed = configureShifts({
    shifts: { Male: { start: '09:00', end: '19:00' }, Female: { start: '10:00', end: '17:00' } },
    breaks: [{ label: 'Lunch', from: '13:00', to: '14:00' }]
  });
  assert.equal(changed.breaks.length, 1);
  assert.equal(shiftMinutesFor({ gender: 'Male' }), 540);
  assert.equal(shiftMinutesFor({ gender: 'Female' }), 360);
  assert.equal(configureShifts(null).breaks.length, 3);
  assert.equal(shiftMinutesFor({ gender: 'Male' }), 660);

  // Breaks are sorted, and a configuration that cannot be worked is refused.
  assert.deepEqual(readShiftSettings({ shifts: shiftSettings().shifts, breaks: [{ label: 'B', from: '16:00', to: '16:15' }, { label: 'A', from: '11:00', to: '11:15' }] }).breaks.map(row => row.label), ['A', 'B']);
  const shifts = shiftSettings().shifts;
  assert.throws(() => readShiftSettings({ shifts, breaks: [{ label: 'One', from: '11:00', to: '12:00' }, { label: 'Two', from: '11:30', to: '12:30' }] }), /overlaps/);
  assert.throws(() => readShiftSettings({ shifts, breaks: [{ label: 'Early', from: '09:00', to: '09:15' }] }), /outside the female shift/);
  assert.throws(() => readShiftSettings({ shifts, breaks: [{ label: 'Dawn', from: '08:00', to: '08:15' }] }), /outside the male shift/);
  assert.throws(() => readShiftSettings({ shifts: { Male: { start: '09:00', end: '08:00' }, Female: shifts.Female }, breaks: [] }), /must end after it starts/);
  assert.throws(() => readShiftSettings({ shifts: { Male: shifts.Male, Female: { start: '10:00', end: '11:00' } }, breaks: [{ label: 'Long', from: '10:00', to: '11:00' }] }), /no working time/);
});

test('overtime is a day above the worker own shift, counted once per day', () => {
  const workers = { f: { gender: 'Female' }, m: { gender: 'Male' } };
  const days = overtimeDays([
    // One eleven-hour day split across two jobs is one overtime day, not two.
    { labourId: 'f', date: '2026-10-13', minutes: 390, pieces: 90 },
    { labourId: 'f', date: '2026-10-13', minutes: 270, pieces: 60 },
    // A full shift, and five minutes over, are not overtime.
    { labourId: 'f', date: '2026-10-12', minutes: 450, pieces: 100 },
    { labourId: 'm', date: '2026-10-12', minutes: 665, pieces: 400 },
    { labourId: 'm', date: '2026-10-13', minutes: 900, pieces: 500 }
  ], key => workers[key]);
  const of = (worker, date) => days.find(row => row.workerId === worker && row.date === date);
  assert.equal(of('f', '2026-10-13').entries, 2);
  assert.equal(of('f', '2026-10-13').otMinutes, 210);
  assert.equal(of('m', '2026-10-13').otMinutes, 240);
  assert.equal(of('f', '2026-10-12').otMinutes, 0);
  assert.equal(of('m', '2026-10-12').otMinutes, 0);
  // The grace is the line, and an unknown worker falls back to the male shift.
  assert.equal(overtimeMinutes({ gender: 'Female' }, 450 + 14), 0);
  assert.equal(overtimeMinutes({ gender: 'Female' }, 450 + 15), 15);
  assert.equal(overtimeMinutes(undefined, 660), 0);
});
