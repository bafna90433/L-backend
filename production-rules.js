const SHIFTS = {
  Male: { start: '08:30', end: '20:30', breakMinutes: 0, label: '8:30 am – 8:30 pm' },
  Female: { start: '09:30', end: '18:30', breakMinutes: 60, label: '9:30 am – 6:30 pm' }
};
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const id = value => String(value?._id || value?.id || value || '');
const plain = value => value?.toObject?.() || value;
const shiftFor = worker => SHIFTS[worker?.gender === 'Female' ? 'Female' : 'Male'];
const integer = (value, label, maximum = Number.MAX_SAFE_INTEGER) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} must be a nonnegative whole number.`);
  return value;
};
const toMinutes = value => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('Time must use HH:mm (00:00–23:59).');
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
};
// Production dates are UTC-midnight calendar markers, independent of host TZ.
// Only the default "today" clock is interpreted in the factory's IST zone.
const dayKey = value => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value === undefined || value === null || value === '') return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Date must use YYYY-MM-DD.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('Invalid calendar date.');
  return value;
};
const dayStart = value => new Date(`${dayKey(value)}T00:00:00.000Z`);
const dayEnd = value => new Date(dayStart(value).getTime() + 86400000 - 1);
const availableMinutesFor = (worker, day) => {
  const shift = shiftFor(worker);
  if (day?.status === 'leave') return 0;
  const elapsed = Math.max(0, Math.min(toMinutes(day?.outTime || shift.end), toMinutes(shift.end)) - Math.max(toMinutes(day?.inTime || shift.start), toMinutes(shift.start)));
  const minutes = Math.max(0, elapsed - (day?.breakMinutes ?? shift.breakMinutes));
  return day?.status === 'half' ? Math.min(minutes, Math.floor((toMinutes(shift.end) - toMinutes(shift.start) - (day?.breakMinutes ?? shift.breakMinutes)) / 2)) : minutes;
};
const attendance = (worker, body) => {
  const shift = shiftFor(worker);
  const status = body.status ?? 'present';
  if (!['present', 'half', 'leave'].includes(status)) fail('Choose present, half or leave.');
  const inTime = body.inTime || shift.start, outTime = body.outTime || shift.end;
  const start = toMinutes(inTime), end = toMinutes(outTime);
  if (end <= start) fail('Departure must be after arrival.');
  if (start < toMinutes(shift.start) || end > toMinutes(shift.end)) fail('Attendance must be within the worker shift.');
  const breakMinutes = integer(body.breakMinutes ?? shift.breakMinutes, 'Break minutes', end - start);
  const result = { status, inTime, outTime, breakMinutes, note: String(body.note || '').slice(0, 200) };
  result.availableMinutes = availableMinutesFor(worker, result);
  return result;
};
const readEntry = body => {
  if (!body.labourId || !body.toyId || !body.processId) fail('Pick the worker, toy and process.');
  const minutes = integer(body.minutes, 'Minutes', 1440);
  if (!minutes) fail('Minutes must be greater than zero.');
  return { date: dayStart(body.date), labourId: id(body.labourId), toyId: id(body.toyId), processId: id(body.processId), minutes, pieces: integer(body.pieces, 'Pieces'), note: String(body.note || '').slice(0, 200) };
};
const rate = (pieces, minutes) => minutes ? Math.round(pieces * 600 / minutes) / 10 : 0;
// Group a whole day before comparing, and never include that day or future days.
const performanceFlags = entries => {
  const groups = new Map();
  for (const row of entries) {
    const key = `${id(row.labourId)}|${id(row.toyId)}|${id(row.processId)}|${dayKey(row.date)}`;
    const group = groups.get(key) || { date: dayKey(row.date), workerId: id(row.labourId), toyId: id(row.toyId), processId: id(row.processId), minutes: 0, pieces: 0 };
    group.minutes += row.minutes; group.pieces += row.pieces; groups.set(key, group);
  }
  const prior = new Map(), flags = [];
  for (const row of [...groups.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = `${row.workerId}|${row.toyId}|${row.processId}`;
    const history = prior.get(key) || { minutes: 0, pieces: 0, days: 0 };
    const rawUsual = history.minutes ? history.pieces * 60 / history.minutes : 0;
    const rawRate = row.minutes ? row.pieces * 60 / row.minutes : 0;
    if (rawUsual > 0 && row.minutes > 0 && rawRate < rawUsual * .5) flags.push({ ...row, hours: row.minutes / 60, rate: rate(row.pieces, row.minutes), usualRate: rate(history.pieces, history.minutes), baselineDays: history.days, drop: Math.round((1 - rawRate / rawUsual) * 100) });
    history.minutes += row.minutes; history.pieces += row.pieces; history.days++; prior.set(key, history);
  }
  return flags;
};
module.exports = { SHIFTS, fail, id, plain, shiftFor, integer, toMinutes, dayKey, dayStart, dayEnd, availableMinutesFor, attendance, readEntry, rate, performanceFlags };
