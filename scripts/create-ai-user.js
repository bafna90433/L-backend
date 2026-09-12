/**
 * Create (or reset) a login for the AI workspace.
 *
 *   node scripts/create-ai-user.js <username> <password> ["Full Name"]
 *
 * The account gets role 'ai' — it can sign in at /ai.html and use AI Council
 * and Image Studio only. It cannot open the MD's dashboard.
 *
 * Run it again with the same username to reset that user's password.
 */

require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { connectDatabase } = require('../database');
const { User } = require('../models');

async function main() {
  const [username, password, name] = process.argv.slice(2);

  if (!username || !password) {
    console.error('Usage: node scripts/create-ai-user.js <username> <password> ["Full Name"]');
    process.exit(1);
  }

  if (password.length < 6) {
    console.error('Password kam se kam 6 characters ka rakhein.');
    process.exit(1);
  }

  await connectDatabase();

  const hashed = await bcrypt.hash(password, 10);
  const existing = await User.findOne({ username });

  if (existing) {
    if (existing.role !== 'ai') {
      console.error(
        `"${username}" pehle se maujood hai aur uska role '${existing.role}' hai — ` +
        'is script se sirf AI users badle ja sakte hain. Koi doosra username chunein.'
      );
      process.exit(1);
    }
    existing.password = hashed;
    if (name) existing.name = name;
    await existing.save();
    console.log(`Password reset ho gaya: ${username}`);
  } else {
    await User.create({
      username,
      password: hashed,
      name: name || username,
      role: 'ai'
    });
    console.log(`AI user ban gaya: ${username}`);
  }

  console.log('Login: <app-url>/ai.html');
  process.exit(0);
}

main().catch(error => {
  console.error('Failed:', error.message);
  process.exit(1);
});
