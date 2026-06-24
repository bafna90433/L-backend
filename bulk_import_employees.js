// bulk_import_employees.js
// Reads ALL EMPLOYEES NAME LIST (2).xlsx and adds all employees to Labour DB
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const path = require('path');

const MONGO_URI = 'mongodb://127.0.0.1:27017/LabourManagement';

// Read existing models schema
const LabourSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  empCode: { type: String, trim: true },
  whatsapp: { type: String, default: '' },
  monthlySalary: { type: Number, default: 0 },
  workingHours: { type: Number, default: 12 },
  imageUrl: { type: String, default: '' },
  status: { type: String, default: 'active' },
  department: { type: String, default: '' },
  employeeType: { type: String, default: 'labourer' },  // labourer or staff
  gender: { type: String, default: '' },
  joinDate: { type: String, default: '' },
  designation: { type: String, default: '' },
}, { timestamps: true });

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const Labour = mongoose.model('Labour', LabourSchema);

  // Read Excel
  const xlsxPath = path.join(__dirname, '..', 'ALL EMPLOYEES NAME LIST (2).xlsx');
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Parse employees (skip header rows — data starts at row index 6)
  const employees = [];
  for (let i = 6; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0] || !row[1]) continue;
    const empCode = String(row[0]).trim();
    const name = String(row[1]).trim();
    if (!name) continue;
    employees.push({ empCode, name });
  }

  console.log(`\n📋 Found ${employees.length} employees in Excel\n`);

  // Get existing employees
  const existing = await Labour.find({}, 'name empCode');
  const existingCodes = new Set(existing.map(e => String(e.empCode || '').trim().toLowerCase()));
  const existingNames = new Set(existing.map(e => (e.name || '').trim().toLowerCase()));

  let added = 0;
  let skipped = 0;

  for (const emp of employees) {
    const codeLower = emp.empCode.toLowerCase();
    const nameLower = emp.name.toLowerCase();

    if (existingCodes.has(codeLower) || existingNames.has(nameLower)) {
      console.log(`  ⏭️  SKIP (already exists): [${emp.empCode}] ${emp.name}`);
      skipped++;
      continue;
    }

    // Determine gender from name patterns (basic heuristic)
    const femaleKeywords = ['kumari', 'devi', 'bai', 'wati', '.k', '.m', '.r', '.s', 'banu', 'rani', 'priya', 'nithya', 'rekha', 'valli', 'poonkodi', 'ramani', 'mamata', 'shanthi', 'sathoshini', 'binodini', 'riddhi', 'ramya', 'sneka', 'sangeetha', 'vadivalagi', 'palaniammal', 'savitha', 'uma', 'vimala', 'kalaivani', 'veni', 'danalakshmi', 'esther', 'nithyasree', 'priyanga', 'rema', 'sindhuja', 'chithra', 'vennila', 'manjula', 'radhika', 'bhabani', 'sathiya', 'padmabati', 'maheshtwari'];
    const nameL = emp.name.toLowerCase();
    const isLikelyFemale = femaleKeywords.some(k => nameL.includes(k));

    // Determine if staff or labourer based on emp code prefix
    const isStaff = emp.empCode.startsWith('B');

    try {
      await Labour.create({
        name: emp.name,
        empCode: emp.empCode,
        whatsapp: '',
        monthlySalary: 0,
        workingHours: 12,
        imageUrl: '',
        status: 'active',
        department: '',
        employeeType: isStaff ? 'staff' : 'labourer',
        gender: isLikelyFemale ? 'female' : 'male',
        joinDate: '',
        designation: '',
      });
      console.log(`  ✅ ADDED: [${emp.empCode}] ${emp.name} (${isStaff ? 'Staff' : 'Labourer'}, ${isLikelyFemale ? 'Female' : 'Male'})`);
      added++;
    } catch (e) {
      console.log(`  ❌ ERROR adding [${emp.empCode}] ${emp.name}: ${e.message}`);
    }
  }

  console.log(`\n=============================`);
  console.log(`✅ Added:   ${added} employees`);
  console.log(`⏭️  Skipped: ${skipped} (already existed)`);
  console.log(`=============================\n`);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
