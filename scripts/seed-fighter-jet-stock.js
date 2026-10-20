/**
 * Put the fighter jet's parts on the shelf and map what body assembly spends.
 *
 * Everything here comes from the factory's own sheet (FJ — Stock management):
 * the part codes, the eight SC-2 screws, two wings, one gearbox and so on. It
 * is written as a script rather than typed into the panel because the same
 * shape has to be repeated for forty-odd toys, and a sheet per toy is far less
 * work than a hundred dropdowns.
 *
 *   node scripts/seed-fighter-jet-stock.js            # says what it would do
 *   node scripts/seed-fighter-jet-stock.js --apply    # does it
 *
 * Run it again safely: an item whose code is already on the shelf is left
 * alone, and a mapped line is corrected rather than added twice.
 *
 * Packing is deliberately NOT mapped here. The sheet describes three different
 * packings (Reliance inner A30, carton A31, Regular inner A18) and which one a
 * work step means is a question for the floor, not for a guess in a script —
 * so the packing items are created and the lines are printed for you to attach
 * on the panel's "What a job uses" tab.
 */

require('dotenv').config({ quiet: true });
const { connectDatabase } = require('../database');
const { StockItem, StockRecipe, Toy, ToyProcess } = require('../models');

const apply = process.argv.includes('--apply');
const id = value => String(value?._id || value?.id || value || '');

// Codes exactly as the sheet writes them.
const ITEMS = [
  { code: 'FG01', name: 'Bottom', kind: 'part', toy: true },
  { code: 'FG4', name: 'Top', kind: 'part', toy: true },
  { code: 'FG6', name: 'Wing', kind: 'part', toy: true },
  { code: 'FG3', name: 'Back missile', kind: 'part', toy: true },
  { code: 'FG07', name: 'Side missile', kind: 'part', toy: true },
  { code: 'FG05', name: 'Front wheel', kind: 'part', toy: true },
  { code: 'FG-2', name: 'Front wheel stick', kind: 'part', toy: true },
  { code: 'FG08', name: 'Side wheel', kind: 'part', toy: true },
  { code: 'FG09', name: 'Gearbox (without wheel)', kind: 'part', toy: true },
  // Screws are common: one shelf, drawn down by whatever is being made.
  { code: 'SC-2', name: 'Screw SC-2', kind: 'screw', toy: false },
  { code: 'SC-4', name: 'Screw SC-4', kind: 'screw', toy: false },
  { code: 'WINDUP-BOX', name: 'Windup box', kind: 'packing', unit: 'box', toy: true },
  { code: 'WHITE-TRAY', name: 'White tray', kind: 'packing', unit: 'tray', toy: true },
  { code: 'A30', name: 'Reliance inner A30', kind: 'packing', toy: true },
  { code: 'A31', name: 'Reliance carton A31', kind: 'packing', toy: true },
  { code: 'A18', name: 'Regular inner A18', kind: 'packing', toy: true }
];

/** What one finished jet takes, straight off the sheet. */
const BODY = [
  { code: 'SC-2', qty: 8, note: 'body' },
  { code: 'SC-4', qty: 1, note: 'front wheel' },
  { code: 'FG6', qty: 2, note: 'wings' },
  { code: 'FG09', qty: 1, note: 'gearbox' },
  { code: 'FG3', qty: 1, note: 'back missile' },
  { code: 'FG05', qty: 1, note: 'front wheel' },
  { code: 'FG-2', qty: 1, note: 'front wheel stick' },
  { code: 'FG07', qty: 2, note: 'missile' },
  // Not spelled out on the sheet, but a jet has one of each and two side
  // wheels. Change these on the panel if the floor says otherwise.
  { code: 'FG4', qty: 1, note: 'top — assumed, please confirm' },
  { code: 'FG01', qty: 1, note: 'bottom — assumed, please confirm' },
  { code: 'FG08', qty: 2, note: 'side wheels — assumed, please confirm' }
];

const PACKING_TODO = [
  'Windup box — 1 per 8 pcs (the sheet: one box holds 8 jets)',
  'White tray — 1 per 8 pcs (goes in the windup tray with the box)',
  'Reliance inner A30 — 1 per 8 pcs',
  'Reliance carton A31 — 1 per 64 pcs (8 inners)',
  'Regular inner A18 — 1 per 16 pcs (2 windup boxes)'
];

async function main() {
  await connectDatabase();

  const toys = await Toy.find({});
  const jet = toys.find(toy => /fighter/i.test(toy.name || '') && toy.isActive !== false);
  if (!jet) {
    console.error(`No active toy with "fighter" in its name. Found: ${toys.filter(toy => toy.isActive !== false).map(toy => toy.name).join(', ')}`);
    process.exit(1);
  }
  const steps = (await ToyProcess.find({})).filter(step => id(step.toyId) === id(jet) && step.isActive !== false);
  const assembly = steps.find(step => /body/i.test(step.name || '') && /assem/i.test(step.name || ''))
    || steps.find(step => /assem/i.test(step.name || ''));

  console.log(`Toy: ${jet.name}`);
  console.log(`Work steps on it: ${steps.length ? steps.map(step => step.name).join(' · ') : 'none'}`);
  console.log(`Body assembly step: ${assembly ? assembly.name : 'NOT FOUND — add one on Categories & toys first'}`);
  console.log('');

  const onShelf = await StockItem.find({});
  const byCode = new Map(onShelf.filter(item => item.isActive !== false).map(item => [String(item.code || '').toLowerCase(), item]));
  const created = [];
  for (const wanted of ITEMS) {
    const existing = byCode.get(wanted.code.toLowerCase());
    if (existing) { console.log(`  already there  ${wanted.code.padEnd(11)} ${existing.name}`); continue; }
    console.log(`  add            ${wanted.code.padEnd(11)} ${wanted.name}${wanted.toy ? '' : '   (common to every toy)'}`);
    if (!apply) {
      // Stand the item in for the preview, so the mapping below can be shown
      // as it would be rather than as a list of missing items.
      const pretend = { ...wanted, _id: `would-be-${wanted.code}` };
      byCode.set(wanted.code.toLowerCase(), pretend);
      created.push(pretend);
      continue;
    }
    const made = await StockItem.create({
      code: wanted.code, name: wanted.name, kind: wanted.kind, unit: wanted.unit || 'pcs',
      toyId: wanted.toy ? id(jet) : '', opening: 0, minLevel: 0, isActive: true, createdAt: new Date()
    });
    byCode.set(wanted.code.toLowerCase(), made);
    created.push(made);
  }

  console.log('');
  if (!assembly) {
    console.log('Body assembly is not mapped: that work step does not exist on this toy yet.');
  } else {
    const lines = await StockRecipe.find({});
    for (const line of BODY) {
      const item = byCode.get(line.code.toLowerCase());
      if (!item) { console.log(`  skip           ${line.code} — item missing`); continue; }
      const already = lines.find(row => id(row.toyId) === id(jet) && id(row.processId) === id(assembly) && id(row.itemId) === id(item));
      const shape = `${line.qty} per 1 pc`.padEnd(12);
      console.log(`  ${already ? 'correct to   ' : 'map          '}  ${line.code.padEnd(11)} ${shape} ${line.note}`);
      if (!apply) continue;
      if (already) await StockRecipe.findByIdAndUpdate(id(already), { qty: line.qty, per: 1, note: line.note });
      else await StockRecipe.create({ toyId: id(jet), processId: id(assembly), itemId: id(item), qty: line.qty, per: 1, note: line.note, createdAt: new Date() });
    }
  }

  console.log('');
  console.log('Packing is left for you, on "What a job uses" — pick the packing work step and add:');
  for (const todo of PACKING_TODO) console.log(`  · ${todo}`);
  console.log('');
  console.log(apply
    ? 'Done. Opening stock is zero on every new item — put the real figures in from the panel, or receive them as stock in.'
    : 'Nothing was written. Run it again with --apply to do it.');
  process.exit(0);
}

main().catch(error => {
  console.error('Failed:', error.message);
  process.exit(1);
});
