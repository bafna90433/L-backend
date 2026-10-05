const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { availableMinutesFor, attendance, readEntry, dayStart, dayKey, toMinutes, performanceFlags, configureShifts, shiftSettings, readShiftSettings, breakMinutesFor } = require('../production-rules');

test('shift availability covers actual breaks, leave, half, late and early attendance', () => {
  // The floor's own figures: 12 hours less an hour of breaks is 11, and
  // 8 hours 30 less the same hour is 7 hours 30.
  assert.equal(availableMinutesFor({ gender: 'Male' }), 660);
  assert.equal(availableMinutesFor({ gender: 'Female' }), 450);
  assert.equal(attendance({ gender: 'Female' }, { inTime: '10:30', outTime: '17:30', breakMinutes: 30 }).availableMinutes, 390);
  assert.equal(attendance({ gender: 'Male' }, { status: 'half' }).availableMinutes, 330);
  assert.equal(attendance({ gender: 'Female' }, { status: 'half' }).availableMinutes, 225);
  assert.equal(attendance({ gender: 'Female' }, { status: 'half', breakMinutes: 0 }).availableMinutes, 255);
  assert.equal(attendance({ gender: 'Female' }, { status: 'leave' }).availableMinutes, 0);
});
test('rejects impossible calendars, invalid clock values, negative/fractional input and coercion', () => {
  for (const date of ['2026-02-29', '2026-13-01', '2026-10-05T00:00:00Z', '05/10/2026']) assert.throws(() => dayStart(date));
  for (const time of ['24:00', '09:60', '9:30', '09:30junk']) assert.throws(() => toMinutes(time));
  for (const pieces of [-1, 1.2, '12', null, Number.POSITIVE_INFINITY]) assert.throws(() => readEntry({ labourId: 'w', toyId: 't', processId: 'p', minutes: 60, pieces }));
  for (const minutes of [0, -1, 1.5, '60', 1441]) assert.throws(() => readEntry({ labourId: 'w', toyId: 't', processId: 'p', minutes, pieces: 0 }));
  assert.throws(() => attendance({ gender: 'Female' }, { inTime: '12:00', outTime: '11:00' }));
  assert.throws(() => attendance({ gender: 'Female' }, { inTime: '17:30', outTime: '18:30', breakMinutes: 61 }));
  assert.throws(() => attendance({ gender: 'Male' }, { status: 'absent' }));
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
  assert.equal(availableMinutesFor({ gender: 'Female' }, { inTime: '09:30', outTime: '13:00' }), 195);
  assert.equal(availableMinutesFor({ gender: 'Female' }, { inTime: '09:30', outTime: '16:00' }), 345);
  assert.equal(breakMinutesFor({ gender: 'Female' }, '09:30', '13:00'), 15);
  assert.equal(breakMinutesFor({ gender: 'Male' }, '08:30', '20:30'), 60);

  const changed = configureShifts({
    shifts: { Male: { start: '09:00', end: '19:00' }, Female: { start: '10:00', end: '17:00' } },
    breaks: [{ label: 'Lunch', from: '13:00', to: '14:00' }]
  });
  assert.equal(changed.breaks.length, 1);
  assert.equal(availableMinutesFor({ gender: 'Male' }), 540);
  assert.equal(availableMinutesFor({ gender: 'Female' }), 360);
  assert.equal(configureShifts(null).breaks.length, 3);
  assert.equal(availableMinutesFor({ gender: 'Male' }), 660);

  // Breaks are sorted, and a configuration that cannot be worked is refused.
  assert.deepEqual(readShiftSettings({ shifts: shiftSettings().shifts, breaks: [{ label: 'B', from: '16:00', to: '16:15' }, { label: 'A', from: '11:00', to: '11:15' }] }).breaks.map(row => row.label), ['A', 'B']);
  const shifts = shiftSettings().shifts;
  assert.throws(() => readShiftSettings({ shifts, breaks: [{ label: 'One', from: '11:00', to: '12:00' }, { label: 'Two', from: '11:30', to: '12:30' }] }), /overlaps/);
  assert.throws(() => readShiftSettings({ shifts, breaks: [{ label: 'Early', from: '09:00', to: '09:15' }] }), /outside the female shift/);
  assert.throws(() => readShiftSettings({ shifts, breaks: [{ label: 'Dawn', from: '08:00', to: '08:15' }] }), /outside the male shift/);
  assert.throws(() => readShiftSettings({ shifts: { Male: { start: '09:00', end: '08:00' }, Female: shifts.Female }, breaks: [] }), /must end after it starts/);
  assert.throws(() => readShiftSettings({ shifts: { Male: shifts.Male, Female: { start: '10:00', end: '11:00' } }, breaks: [{ label: 'Long', from: '10:00', to: '11:00' }] }), /no working time/);
});
