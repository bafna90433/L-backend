require('dotenv').config();
const mongoose = require('mongoose');
const xlsx = require('xlsx');
const path = require('path');
const { Labour } = require('./models');

async function importData() {
  await mongoose.connect('mongodb://127.0.0.1:27017/LabourManagement');
  console.log('Connected to MongoDB successfully!');

  const filePath = path.join(__dirname, '../ALL EMPLOYEES NAME LIST (2).xlsx');
  console.log('Reading file:', filePath);
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Convert sheet to 2D array of rows
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  let count = 0;
  let skipped = 0;
  let updated = 0;

  // The header row 'Employee ID', 'First Name' is at row index 5
  // The actual data starts at index 6
  for (let i = 6; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const empCodeStr = row[0];
    const nameStr = row[1];

    if (empCodeStr && nameStr) {
      const empCode = empCodeStr.toString().trim();
      const name = nameStr.toString().trim();

      // Check if employee with this empCode already exists
      const existing = await Labour.findOne({ empCode });
      if (!existing) {
        await Labour.create({
          name: name,
          empCode: empCode,
          whatsapp: 'Not Provided',
          monthlySalary: 0,
          employeeType: 'labourer',
          status: 'active',
          shiftStart: '08:30',
          shiftEnd: '20:30',
          workingHours: 12
        });
        count++;
      } else {
        // If they already exist, update name if it changed
        if (existing.name !== name) {
          existing.name = name;
          await existing.save();
          updated++;
        } else {
          skipped++;
        }
      }
    }
  }

  console.log(`\n--- IMPORT RESULTS ---`);
  console.log(`Total new labourers inserted: ${count}`);
  console.log(`Total labourers updated: ${updated}`);
  console.log(`Total skipped (already exists): ${skipped}`);
  console.log(`-----------------------\n`);
  process.exit(0);
}

importData().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
