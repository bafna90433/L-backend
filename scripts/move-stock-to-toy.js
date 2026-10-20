/**
 * Move a toy's parts and its mapping onto another toy.
 *
 *   node scripts/move-stock-to-toy.js --from "Fighter Jet" --to "FIGHTER-JET"
 *   node scripts/move-stock-to-toy.js --from "Fighter Jet" --to "FIGHTER-JET" --apply
 *   node scripts/move-stock-to-toy.js --from A --to B --step "Body assembly=BODY ASSEMBLE"
 *
 * Catalogues grow by hand, so the same toy can end up written twice — "Fighter
 * Jet" and "FIGHTER-JET" — and work recorded against one while its parts were
 * mapped to the other. Stock then never moves, because the entry and the
 * recipe never meet.
 *
 * This repoints the items and the recipe lines at the toy the floor actually
 * records against. Work steps are matched by name with the punctuation and
 * case ignored, so "Body assembly" finds "BODY ASSEMBLE"; anything that cannot
 * be matched is reported and left alone rather than guessed at.
 *
 * Nothing is written without --apply, and no production entry or movement is
 * touched: what the shelf already spent stays spent.
 */

require('dotenv').config({ quiet: true });
const { connectDatabase } = require('../database');
const { StockItem, StockRecipe, Toy, ToyProcess } = require('../models');

const id = value => String(value?._id || value?.id || value || '');
const flat = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * How far apart two names are, letter by letter.
 *
 * Hand-typed catalogues spell the same step differently — "Body assembly" and
 * "BODY ASSEMBLE", "WINGS GUMING" and "Wings gumming" — so a strict comparison
 * finds nothing. A couple of letters of slack matches those without matching
 * two genuinely different steps.
 */
const distance = (left, right) => {
  const a = flat(left), b = flat(right);
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const swap = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = swap;
    }
  }
  return row[b.length];
};
const SLACK = 2;

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : '';
}

async function main() {
  const fromName = arg('from');
  const toName = arg('to');
  const apply = process.argv.includes('--apply');
  if (!fromName || !toName) {
    console.error('Usage: node scripts/move-stock-to-toy.js --from "<toy>" --to "<toy>" [--apply]');
    process.exit(1);
  }

  await connectDatabase();
  const toys = (await Toy.find({})).filter(toy => toy.isActive !== false);
  const pick = wanted => {
    const exact = toys.filter(toy => String(toy.name || '').trim().toLowerCase() === wanted.trim().toLowerCase());
    if (exact.length === 1) return exact[0];
    const loose = toys.filter(toy => flat(toy.name) === flat(wanted));
    if (loose.length === 1) return loose[0];
    return null;
  };
  const from = pick(fromName), to = pick(toName);
  for (const [label, name, toy] of [['--from', fromName, from], ['--to', toName, to]]) {
    if (!toy) {
      console.error(`${label} "${name}" did not match exactly one toy. Toys: ${toys.map(row => row.name).join(' | ')}`);
      process.exit(1);
    }
  }
  if (id(from) === id(to)) {
    console.error('Both names point at the same toy, so there is nothing to move.');
    process.exit(1);
  }

  const steps = await ToyProcess.find({});
  const stepsOf = toy => steps.filter(step => id(step.toyId) === id(toy) && step.isActive !== false);
  const targetSteps = stepsOf(to);
  // Names the caller pinned by hand win over any guess: --step "old=new"
  const pinned = new Map();
  process.argv.forEach((value, index) => {
    if (value !== '--step') return;
    const pair = String(process.argv[index + 1] || '');
    const at = pair.indexOf('=');
    if (at > 0) pinned.set(flat(pair.slice(0, at)), flat(pair.slice(at + 1)));
  });
  const matchStep = name => {
    const wanted = pinned.get(flat(name));
    if (wanted) return targetSteps.find(step => flat(step.name) === wanted) || null;
    const exact = targetSteps.find(step => flat(step.name) === flat(name));
    if (exact) return exact;
    const near = targetSteps
      .map(step => ({ step, gap: distance(step.name, name) }))
      .filter(row => row.gap <= SLACK)
      .sort((a, b) => a.gap - b.gap);
    // Two steps equally close is not a match, it is a question.
    if (near.length === 1 || (near.length > 1 && near[0].gap < near[1].gap)) return near[0].step;
    return null;
  };
  console.log(`From: ${from.name}   (${stepsOf(from).map(step => step.name).join(' · ') || 'no work steps'})`);
  console.log(`To:   ${to.name}   (${stepsOf(to).map(step => step.name).join(' · ') || 'no work steps'})`);
  console.log('');

  const items = (await StockItem.find({})).filter(item => item.isActive !== false && id(item.toyId) === id(from));
  for (const item of items) console.log(`  item   ${String(item.code || '—').padEnd(12)} ${item.name}`);

  const lines = (await StockRecipe.find({})).filter(row => id(row.toyId) === id(from));
  const moves = [];
  let stuck = 0;
  for (const line of lines) {
    const was = steps.find(step => id(step) === id(line.processId));
    const now = was ? matchStep(was.name) : null;
    const itemName = (await StockItem.findById(id(line.itemId)))?.name || 'archived item';
    if (!now) {
      console.log(`  stuck  ${itemName} — "${was?.name || 'archived step'}" has no match on ${to.name}; pin it with --step "${was?.name || ''}=<step on ${to.name}>"`);
      stuck += 1;
      continue;
    }
    console.log(`  line   ${itemName.padEnd(26)} ${was.name} → ${now.name}   (${line.qty} per ${line.per})`);
    moves.push({ line, step: now });
  }

  console.log('');
  if (stuck) console.log(`${stuck} line${stuck === 1 ? '' : 's'} cannot be placed; add that work step on ${to.name} first, or move those by hand.`);
  if (!apply) {
    console.log(`Dry run. ${items.length} item${items.length === 1 ? '' : 's'} and ${moves.length} mapped line${moves.length === 1 ? '' : 's'} would move. Add --apply to do it.`);
    process.exit(0);
  }

  for (const item of items) await StockItem.findByIdAndUpdate(id(item), { toyId: id(to) });
  for (const move of moves) await StockRecipe.findByIdAndUpdate(id(move.line), { toyId: id(to), processId: id(move.step) });
  console.log(`Done. ${items.length} items and ${moves.length} lines now sit on ${to.name}.`);
  console.log('Stock already spent is untouched — only where the parts hang has changed.');
  process.exit(0);
}

main().catch(error => {
  console.error('Failed:', error.message);
  process.exit(1);
});
