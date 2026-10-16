require('dotenv').config();
const { connectDatabase } = require('../database');
const { User, Operation, Task } = require('../models');

/**
 * Change the name a person is shown by, everywhere it was written down.
 *
 * Most screens read the name off the User row, so renaming that alone fixes
 * them. But a few places copy the name in at the time — an operation's trail,
 * the lines people write on it, a task comment — so that the record still
 * reads correctly years later. Those copies are what this fixes. It is the
 * same person either way; nothing but the label changes.
 *
 *   node scripts/rename-display-name.js --from "Owner Admin" --to "MD"
 *   node scripts/rename-display-name.js --from "Owner Admin" --to "MD" --apply
 *
 * Audit trails are left alone on purpose: a log says what it said at the time.
 */
const args = process.argv.slice(2);
const flag = name => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : '';
};
const from = flag('from');
const to = flag('to');
const apply = args.includes('--apply');

if (!from || !to) {
  console.error('Usage: node scripts/rename-display-name.js --from "Old Name" --to "New Name" [--apply]');
  process.exit(1);
}

const same = value => String(value || '').trim().toLowerCase() === from.trim().toLowerCase();
const swap = value => (same(value) ? to : value);

(async () => {
  await connectDatabase();
  const plan = [];

  const users = (await User.find({})).filter(user => same(user.name));
  for (const user of users) plan.push({ what: 'account', id: String(user._id || user.id), detail: `${user.name} (${user.username})` });

  const operations = await Operation.find({});
  const touchedOperations = [];
  for (const row of operations) {
    const assignments = (row.assignments || []).map(hop => ({ ...hop, fromName: swap(hop.fromName), toName: swap(hop.toName), byName: swap(hop.byName) }));
    const messages = (row.messages || []).map(line => ({ ...line, byName: swap(line.byName) }));
    const fields = {
      createdByName: swap(row.createdByName),
      assignedToName: swap(row.assignedToName),
      doneByName: swap(row.doneByName)
    };
    const changed = JSON.stringify(assignments) !== JSON.stringify(row.assignments || [])
      || JSON.stringify(messages) !== JSON.stringify(row.messages || [])
      || Object.entries(fields).some(([key, value]) => value !== (row[key] || ''));
    if (changed) {
      touchedOperations.push({ row, assignments, messages, fields });
      plan.push({ what: 'operation', id: String(row._id || row.id), detail: row.title });
    }
  }

  const tasks = await Task.find({});
  const touchedTasks = [];
  for (const row of tasks) {
    const comments = (row.comments || []).map(comment => ({ ...comment, authorName: swap(comment.authorName) }));
    if (JSON.stringify(comments) !== JSON.stringify(row.comments || [])) {
      touchedTasks.push({ row, comments });
      plan.push({ what: 'task comment', id: String(row._id || row.id), detail: row.title });
    }
  }

  console.log(`"${from}" -> "${to}"`);
  console.log(`  accounts        : ${plan.filter(item => item.what === 'account').length}`);
  console.log(`  operations      : ${touchedOperations.length}`);
  console.log(`  tasks (comments): ${touchedTasks.length}`);
  for (const item of plan.slice(0, 20)) console.log(`    ${item.what.padEnd(16)} ${item.detail}`);
  if (plan.length > 20) console.log(`    …and ${plan.length - 20} more`);

  if (!apply) {
    console.log('\nDry run. Nothing was written. Add --apply to make the change.');
    process.exit(0);
  }

  for (const user of users) await User.findByIdAndUpdate(String(user._id || user.id), { name: to });
  for (const item of touchedOperations) {
    await Operation.findByIdAndUpdate(String(item.row._id || item.row.id), { ...item.fields, assignments: item.assignments, messages: item.messages });
  }
  for (const item of touchedTasks) {
    await Task.findByIdAndUpdate(String(item.row._id || item.row.id), { comments: item.comments });
  }
  console.log(`\nDone. ${plan.length} records now read "${to}".`);
  process.exit(0);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
