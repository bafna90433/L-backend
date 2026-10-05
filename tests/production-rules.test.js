const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { availableMinutesFor, attendance, readEntry, dayStart, dayKey, toMinutes, performanceFlags } = require('../production-rules');

test('shift availability covers actual breaks, leave, half, late and early attendance', () => {
  assert.equal(availableMinutesFor({ gender: 'Male' }), 720);
  assert.equal(availableMinutesFor({ gender: 'Female' }), 480);
  assert.equal(attendance({ gender: 'Female' }, { inTime: '10:30', outTime: '17:30', breakMinutes: 30 }).availableMinutes, 390);
  assert.equal(attendance({ gender: 'Male' }, { status: 'half' }).availableMinutes, 360);
  assert.equal(attendance({ gender: 'Female' }, { status: 'half' }).availableMinutes, 240);
  assert.equal(attendance({ gender: 'Female' }, { status: 'half', breakMinutes: 0 }).availableMinutes, 270);
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
