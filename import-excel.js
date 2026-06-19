require('dotenv').config();
const mongoose = require('mongoose');
const xlsx = require('xlsx');

const LabourSchema = new mongoose.Schema({
  name: { type: String, required: true },
  whatsapp: { type: String, required: true },
  monthlySalary: { type: Number, required: true },
  imageUrl: { type: String, default: '' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  employeeType: { type: String, enum: ['labourer', 'staff'], default: 'labourer' },
  department: { type: String, default: '' },
  phonePeNumber: { type: String, default: '' },
  upiId: { type: String, default: '' },
  phonePeQrUrl: { type: String, default: '' },
  faceEmbedding: { type: [Number], default: [] },
  workingHours: { type: Number, default: 8 },
  shiftStart: { type: String, default: '08:30' },
  shiftEnd: { type: String, default: '20:30' },
  gender: { type: String, enum: ['Male', 'Female', 'Other'], default: 'Male' },
  empCode: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const Labour = mongoose.models.Labour || mongoose.model('Labour', LabourSchema);

async function importData() {
  await mongoose.connect('mongodb://127.0.0.1:27017/LabourManagement');
  console.log('Connected to MongoDB');

  const filePath = '../admin-owner/ALL EMPLOYEES NAME LIST (1).xlsx';
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const data = xlsx.utils.sheet_to_json(sheet);
  let count = 0;

  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    const empCodeStr = row['Total Time Card Report'];
    let nameStr = row['__EMPTY'];
    
    if (empCodeStr && typeof empCodeStr === 'string' && (empCodeStr.includes('Total') || empCodeStr.includes('Printed'))) {
      continue;
    }

    if (!nameStr && row['__EMPTY_1']) nameStr = row['__EMPTY_1'];

    if (empCodeStr && nameStr) {
      const empCode = empCodeStr.toString().trim();
      const name = nameStr.toString().trim();

      const existing = await Labour.findOne({ empCode });
      if (!existing) {
        await Labour.create({
          name: name,
          empCode: empCode,
          whatsapp: 'Not Provided',
          monthlySalary: 0,
          employeeType: 'labourer',
          status: 'active'
        });
        count++;
      } else {
        // console.log(`Skipping existing: ${name} (${empCode})`);
      }
    }
  }

  console.log(`Import finished! Total new labourers inserted: ${count}`);
  process.exit(0);
}

importData().catch(err => {
  console.error(err);
  process.exit(1);
});
