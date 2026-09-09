require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const conn = await mongoose.connect(process.env.MONGO_URI);
  const admin = conn.connection.db.admin();
  const dbs = await admin.listDatabases();
  console.log('DATABASES:', dbs.databases.map(d => d.name));
  for (const d of dbs.databases) {
    if (['admin', 'local', 'config'].includes(d.name)) continue;
    const db = conn.connection.client.db(d.name);
    const cols = await db.listCollections().toArray();
    for (const c of cols) {
      const count = await db.collection(c.name).countDocuments();
      if (count > 0) {
        console.log(`- ${d.name}.${c.name}: ${count} docs`);
      }
    }
  }
}

main().catch(console.error).finally(() => mongoose.disconnect());
