// Shift and break times are the factory's to set, so they live in settings and
// are only seeded from these. Breaks are deducted by overlap, not as a flat
// hour: someone who leaves before lunch never took lunch.
const DEFAULT_BREAKS = [
  { label: 'Morning tea', from: '11:00', to: '11:15' },
  { label: 'Lunch', from: '13:00', to: '13:30' },
  { label: 'Evening tea', from: '16:00', to: '16:15' }
];
const DEFAULT_SHIFTS = { Male: { start: '08:30', end: '20:30' }, Female: { start: '09:30', end: '18:00' } };
const clock = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const pretty = value => {
  const total = clock(value), hour = Math.floor(total / 60), minute = total % 60;
  return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
};
let settings = { shifts: DEFAULT_SHIFTS, breaks: DEFAULT_BREAKS };
const overlap = (fromA, toA, fromB, toB) => Math.max(0, Math.min(toA, toB) - Math.max(fromA, fromB));
/** Break minutes that fall inside a worked window. */
const breakMinutesWithin = (from, to) => settings.breaks.reduce((total, row) => total + overlap(clock(row.from), clock(row.to), from, to), 0);
const buildShift = gender => {
  const shift = settings.shifts[gender];
  return { ...shift, breaks: settings.breaks, breakMinutes: breakMinutesWithin(clock(shift.start), clock(shift.end)), label: `${pretty(shift.start)} – ${pretty(shift.end)}` };
};
const SHIFTS = { get Male() { return buildShift('Male'); }, get Female() { return buildShift('Female'); } };
const shiftSettings = () => ({ shifts: { Male: { ...settings.shifts.Male }, Female: { ...settings.shifts.Female } }, breaks: settings.breaks.map(row => ({ ...row })) });
const configureShifts = value => { settings = value ? readShiftSettings(value) : { shifts: DEFAULT_SHIFTS, breaks: DEFAULT_BREAKS }; return shiftSettings(); };
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const id = value => String(value?._id || value?.id || value || '');
const plain = value => value?.toObject?.() || value;
const shiftFor = worker => buildShift(worker?.gender === 'Female' ? 'Female' : 'Male');
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
  const from = Math.max(toMinutes(day?.inTime || shift.start), toMinutes(shift.start));
  const to = Math.min(toMinutes(day?.outTime || shift.end), toMinutes(shift.end));
  const elapsed = Math.max(0, to - from);
  const taken = day?.breakMinutes ?? breakMinutesWithin(from, to);
  const minutes = Math.max(0, elapsed - taken);
  return day?.status === 'half' ? Math.min(minutes, Math.floor((toMinutes(shift.end) - toMinutes(shift.start) - (day?.breakMinutes ?? shift.breakMinutes)) / 2)) : minutes;
};
/** The break default shown for a window, so leaving early does not deduct lunch. */
const breakMinutesFor = (worker, inTime, outTime) => {
  const shift = shiftFor(worker);
  return breakMinutesWithin(Math.max(toMinutes(inTime || shift.start), toMinutes(shift.start)), Math.min(toMinutes(outTime || shift.end), toMinutes(shift.end)));
};
const attendance = (worker, body) => {
  const shift = shiftFor(worker);
  const status = body.status ?? 'present';
  if (!['present', 'half', 'leave'].includes(status)) fail('Choose present, half or leave.');
  const inTime = body.inTime || shift.start, outTime = body.outTime || shift.end;
  const start = toMinutes(inTime), end = toMinutes(outTime);
  if (end <= start) fail('Departure must be after arrival.');
  if (start < toMinutes(shift.start) || end > toMinutes(shift.end)) fail('Attendance must be within the worker shift.');
  const breakMinutes = integer(body.breakMinutes ?? breakMinutesWithin(start, end), 'Break minutes', end - start);
  const result = { status, inTime, outTime, breakMinutes, note: String(body.note || '').slice(0, 200) };
  result.availableMinutes = availableMinutesFor(worker, result);
  return result;
};
/** Checks a shift/break configuration before it is stored or applied. */
const readShiftSettings = body => {
  const source = body && typeof body === 'object' ? body : fail('Send shift settings.');
  const shifts = {};
  for (const gender of ['Male', 'Female']) {
    const row = source.shifts?.[gender] || fail(`${gender} shift times are required.`);
    const start = toMinutes(row.start), end = toMinutes(row.end);
    if (end <= start) fail(`${gender} shift must end after it starts.`);
    shifts[gender] = { start: row.start, end: row.end };
  }
  const list = Array.isArray(source.breaks) ? source.breaks : fail('Breaks must be a list.');
  if (list.length > 6) fail('Up to six breaks can be set.');
  const breaks = list.map(row => {
    const label = String(row?.label || '').trim().slice(0, 40) || fail('Every break needs a name.');
    const from = toMinutes(row.from), to = toMinutes(row.to);
    if (to <= from) fail(`${label} must end after it starts.`);
    return { label, from: row.from, to: row.to };
  }).sort((a, b) => clock(a.from) - clock(b.from));
  breaks.forEach((row, index) => {
    const previous = breaks[index - 1];
    if (previous && clock(row.from) < clock(previous.to)) fail(`${row.label} overlaps ${previous.label}.`);
    // A break outside a shift would silently deduct nothing for those workers.
    for (const gender of ['Male', 'Female']) {
      if (clock(row.from) < toMinutes(shifts[gender].start) || clock(row.to) > toMinutes(shifts[gender].end)) fail(`${row.label} falls outside the ${gender.toLowerCase()} shift.`);
    }
  });
  for (const gender of ['Male', 'Female']) {
    const span = toMinutes(shifts[gender].end) - toMinutes(shifts[gender].start);
    const total = breaks.reduce((sum, row) => sum + clock(row.to) - clock(row.from), 0);
    if (total >= span) fail(`Breaks leave no working time in the ${gender.toLowerCase()} shift.`);
  }
  return { shifts, breaks };
};
// How a piece of work should be read. Training is somebody learning the job;
// cover is somebody standing in on a job that is not theirs. Both are real
// output, but only training is kept out of the rankings and records.
const WORK_TYPES = ['regular', 'training', 'cover'];
const readEntry = body => {
  if (!body.labourId || !body.toyId || !body.processId) fail('Pick the worker, toy and process.');
  const minutes = integer(body.minutes, 'Minutes', 1440);
  if (!minutes) fail('Minutes must be greater than zero.');
  const workType = body.workType === undefined || body.workType === null || body.workType === '' ? 'regular' : String(body.workType);
  if (!WORK_TYPES.includes(workType)) fail('Work type must be regular, training or cover.');
  return { date: dayStart(body.date), labourId: id(body.labourId), toyId: id(body.toyId), processId: id(body.processId), minutes, pieces: integer(body.pieces, 'Pieces'), note: String(body.note || '').slice(0, 200), workType };
};
const rate = (pieces, minutes) => minutes ? Math.round(pieces * 600 / minutes) / 10 : 0;
const readTrainingDates = (body, previous = {}) => {
  const start = body.trainingStart ?? previous.trainingStart ?? '', end = body.trainingEnd ?? previous.trainingEnd ?? '';
  if (!start && !end) return { trainingStart: '', trainingEnd: '' };
  if (!start || !end) fail('Training start and end dates are both required.');
  const trainingStart = dayKey(start), trainingEnd = dayKey(end);
  if (trainingEnd < trainingStart) fail('Training end must be on or after its start.');
  return { trainingStart, trainingEnd };
};
const isTrainingOn = (schedule, date) => !!schedule?.trainingStart && !!schedule?.trainingEnd && dayKey(date) >= schedule.trainingStart && dayKey(date) <= schedule.trainingEnd;
// Group a whole day before comparing, and never include that day or future days.
const performanceFlags = entries => {
  const groups = new Map();
  for (const row of entries) {
    // Training contributes to factory output, never to the comparison baseline.
    if (row.isTraining) continue;
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
/**
 * Days where somebody beat the best rate ever recorded for that toy and work
 * step.
 *
 * One day's work on one step counts as one attempt, so a record cannot be set
 * by splitting an entry. A standing best must already exist, or the first
 * person to ever do a job would always be breaking a record, and a short burst
 * cannot set one: an hour is the least that shows a rate anybody can hold.
 */
const RECORD_MIN_MINUTES = 60;
const dailyAttempts = entries => {
  const groups = new Map();
  for (const row of entries) {
    if (row.isTraining) continue;
    const key = `${id(row.labourId)}|${id(row.toyId)}|${id(row.processId)}|${dayKey(row.date)}`;
    const group = groups.get(key) || { date: dayKey(row.date), workerId: id(row.labourId), toyId: id(row.toyId), processId: id(row.processId), minutes: 0, pieces: 0 };
    group.minutes += row.minutes; group.pieces += row.pieces; groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.workerId.localeCompare(b.workerId));
};
const recordBreaks = entries => {
  const groups = { values: () => dailyAttempts(entries) };
  const best = new Map(), breaks = [];
  for (const row of groups.values()) {
    if (row.minutes < RECORD_MIN_MINUTES) continue;
    const key = `${row.toyId}|${row.processId}`;
    const rawRate = row.pieces * 60 / row.minutes, standing = best.get(key);
    if (standing && rawRate > standing.rawRate) {
      breaks.push({
        date: row.date, workerId: row.workerId, toyId: row.toyId, processId: row.processId,
        minutes: row.minutes, hours: row.minutes / 60, pieces: row.pieces, rate: rate(row.pieces, row.minutes),
        previousRate: rate(standing.pieces, standing.minutes), previousWorkerId: standing.workerId, previousDate: standing.date,
        improvement: Math.round((rawRate / standing.rawRate - 1) * 100)
      });
    }
    if (!standing || rawRate > standing.rawRate) best.set(key, { rawRate, pieces: row.pieces, minutes: row.minutes, workerId: row.workerId, date: row.date });
  }
  return breaks;
};
/** The best rate standing on each toy and work step, and who holds it. */
const standingRecords = entries => {
  const best = new Map();
  for (const row of dailyAttempts(entries)) {
    if (row.minutes < RECORD_MIN_MINUTES) continue;
    const key = `${row.toyId}|${row.processId}`;
    const rawRate = row.pieces * 60 / row.minutes, standing = best.get(key);
    if (!standing || rawRate > standing.rawRate) best.set(key, { ...row, rawRate, hours: row.minutes / 60, rate: rate(row.pieces, row.minutes), attempts: (standing?.attempts || 0) + 1 });
    else best.set(key, { ...standing, attempts: standing.attempts + 1 });
  }
  return [...best.values()].sort((a, b) => b.rawRate - a.rawRate);
};
/**
 * A damage record stands on its own: a date, what toy, which part and how many.
 *
 * The two names are typed by hand because a broken part is often not a step in
 * the catalogue, and tying this to a production entry would mean nothing could
 * be logged once the shift it came from was closed.
 */
const readDamage = body => {
  const toyName = String(body.toyName || '').trim().slice(0, 100);
  const partName = String(body.partName || '').trim().slice(0, 100);
  if (!toyName) fail('Type the toy name.');
  if (!partName) fail('Type the damaged part.');
  const qty = integer(body.qty, 'Damage qty', 1000000);
  if (!qty) fail('Damage qty must be greater than zero.');
  return { date: dayStart(body.date), toyName, partName, qty };
};
module.exports = { WORK_TYPES, SHIFTS, DEFAULT_BREAKS, DEFAULT_SHIFTS, configureShifts, shiftSettings, readShiftSettings, breakMinutesFor, breakMinutesWithin, fail, id, plain, shiftFor, integer, toMinutes, dayKey, dayStart, dayEnd, availableMinutesFor, attendance, readEntry, readDamage, rate, performanceFlags, recordBreaks, standingRecords, readTrainingDates, isTrainingOn };
