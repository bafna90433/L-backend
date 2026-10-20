/**
 * Create — or reset the password of — a login for the production panel.
 *
 *   node scripts/create-production-user.js <username> <password> ["Full Name"] [--supervisor]
 *
 * The panel has its own logins, separate from the office staff the MD manages
 * in Settings, which is why a forgotten one cannot be fixed from there. A
 * stored password cannot be read back — it is a hash — so the only way in is
 * to set a new one, and that is what this does.
 *
 * Run it again with the same username to reset that account's password.
 *
 *   default        Production Admin      — entries, reports, masters (parts,
 *                                          toys, workers, stock mapping)
 *   --supervisor   Production Supervisor — records daily production only
 *
 * Against the live database, run it through Railway so it talks to the same
 * database the panel does:
 *
 *   railway run node scripts/create-production-user.js productionadmin <new-password>
 */

require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { connectDatabase } = require('../database');
const { User } = require('../models');

const ROLES = {
  admin: { role: 'production-admin', label: 'Production Admin', can: 'entries, reports and master data' },
  supervisor: { role: 'production-supervisor', label: 'Production Supervisor', can: 'recording daily production' }
};

async function main() {
  const args = process.argv.slice(2);
  const supervisor = args.includes('--supervisor');
  const [username, password, name] = args.filter(arg => !arg.startsWith('--'));

  if (!username || !password) {
    console.error('Usage: node scripts/create-production-user.js <username> <password> ["Full Name"] [--supervisor]');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('Password must be at least 6 characters.');
    process.exit(1);
  }

  await connectDatabase();
  const wanted = supervisor ? ROLES.supervisor : ROLES.admin;
  const hashed = await bcrypt.hash(password, 10);
  const existing = await User.findOne({ username });

  if (existing) {
    // The MD's own login is not resettable from a script: that account opens
    // everything, and it should only ever be changed by the MD themselves.
    if (existing.role === 'owner') {
      console.error(`"${username}" is the MD's own login. Change that from the owner panel, not from here.`);
      process.exit(1);
    }
    const before = existing.role;
    existing.password = hashed;
    existing.role = wanted.role;
    existing.isActive = true;
    if (name) existing.name = name;
    await existing.save();
    console.log(`Password reset for "${username}" (${existing.name}).`);
    if (before !== wanted.role) console.log(`Role moved from '${before}' to '${wanted.role}'.`);
  } else {
    await User.create({
      username,
      password: hashed,
      name: name || username,
      role: wanted.role,
      isActive: true
    });
    console.log(`Created "${username}" as ${wanted.label}.`);
  }

  console.log(`It can sign in to the production panel and handle ${wanted.can}.`);
  console.log('Tell the floor the new password — their saved one will stop working.');
  process.exit(0);
}

main().catch(error => {
  console.error('Failed:', error.message);
  process.exit(1);
});
