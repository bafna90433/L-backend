/**
 * Put stock in against item codes, in one line.
 *
 *   node scripts/stock-in.js SC-2=50000 FG6=8000 WINDUP-BOX=1200
 *   node scripts/stock-in.js --note "Opening count" --date 2026-10-20 SC-2=50000 ...
 *   node scripts/stock-in.js --apply SC-2=50000 ...
 *
 * Filling a shelf for the first time is a list of figures somebody has already
 * counted; this takes that list as it is rather than asking for it a box at a
 * time. Each code becomes its own stock-in movement, exactly as the panel
 * would have written it, so the ledger reads the same either way.
 *
 * Dry run by default — it prints what each code resolves to and what the
 * balance would become. Nothing is written until --apply.
 */

require('dotenv').config({ quiet: true });
const { connectDatabase } = require('../database');
const { StockItem, StockMove } = require('../models');

const id = value => String(value?._id || value?.id || value || '');

function readArgs(argv) {
  const flag = name => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : '';
  };
  const date = flag('date');
  const note = flag('note') || 'Stock count';
  const apply = argv.includes('--apply');
  const skip = new Set();
  for (const name of ['date', 'note']) {
    const at = argv.indexOf(`--${name}`);
    if (at >= 0) { skip.add(at); skip.add(at + 1); }
  }
  const pairs = argv
    .filter((value, index) => !skip.has(index) && !value.startsWith('--'))
    .map(value => {
      const at = value.indexOf('=');
      if (at < 1) return { raw: value, bad: 'write it as CODE=QTY' };
      const code = value.slice(0, at).trim();
      const qty = Number(value.slice(at + 1));
      if (!code) return { raw: value, bad: 'no code' };
      if (!Number.isFinite(qty) || qty <= 0) return { raw: value, code, bad: 'quantity must be more than zero' };
      return { raw: value, code, qty };
    });
  return { date, note, apply, pairs };
}

async function main() {
  const { date, note, apply, pairs } = readArgs(process.argv.slice(2));
  if (!pairs.length) {
    console.error('Usage: node scripts/stock-in.js [--apply] [--date YYYY-MM-DD] [--note "..."] CODE=QTY [CODE=QTY ...]');
    process.exit(1);
  }
  const when = date ? new Date(`${date}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(when.getTime())) {
    console.error('Date must be written as YYYY-MM-DD.');
    process.exit(1);
  }

  await connectDatabase();
  const items = (await StockItem.find({})).filter(item => item.isActive !== false);
  const byCode = new Map(items.map(item => [String(item.code || '').trim().toLowerCase(), item]));
  const moves = await StockMove.find({});
  const sums = new Map();
  for (const move of moves) sums.set(id(move.itemId), (sums.get(id(move.itemId)) || 0) + Number(move.qty || 0));
  const balanceOf = item => Number(item.opening || 0) + (sums.get(id(item)) || 0);

  const ready = [];
  let problems = 0;
  for (const pair of pairs) {
    if (pair.bad) { console.log(`  ?  ${pair.raw.padEnd(22)} ${pair.bad}`); problems += 1; continue; }
    const item = byCode.get(pair.code.toLowerCase());
    if (!item) {
      console.log(`  ?  ${pair.raw.padEnd(22)} no item with code "${pair.code}"`);
      problems += 1;
      continue;
    }
    const was = balanceOf(item);
    console.log(`  +  ${pair.code.padEnd(12)} ${String(pair.qty).padStart(9)} ${String(item.unit || 'pcs').padEnd(5)} ${item.name}   (${was} → ${was + pair.qty})`);
    ready.push({ item, qty: pair.qty });
  }

  console.log('');
  if (problems) {
    // A typo in a code would otherwise land stock on the wrong shelf, or
    // nowhere, so nothing goes in until every line is understood.
    console.error(`${problems} line${problems === 1 ? '' : 's'} could not be read. Fix them and run it again — nothing was written.`);
    process.exit(1);
  }
  if (!apply) {
    console.log(`Dry run. ${ready.length} item${ready.length === 1 ? '' : 's'} would go in on ${when.toISOString().slice(0, 10)} as "${note}". Add --apply to do it.`);
    process.exit(0);
  }

  let done = 0;
  for (const line of ready) {
    await StockMove.create({
      date: when, itemId: id(line.item), qty: line.qty, reason: 'inward',
      entryId: '', toyId: id(line.item.toyId), processId: '', pieces: 0,
      note, byName: 'Stock script', createdAt: new Date()
    });
    done += 1;
  }
  console.log(`Done. ${done} item${done === 1 ? '' : 's'} added to stock on ${when.toISOString().slice(0, 10)}.`);
  process.exit(0);
}

main().catch(error => {
  console.error('Failed:', error.message);
  process.exit(1);
});
