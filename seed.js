require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const xlsx = require('xlsx');
const path = require('path');
const { User, Labour, Attendance, CashTx, AdvanceRequest } = require('./models');

const mongoUri = process.env.MONGO_URI || 'mongodb+srv://Labour:Labour123@labour.ajkpera.mongodb.net/LabourManagement?retryWrites=true&w=majority';

// Excel Date helper
function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'number') {
    // Convert Excel serial date
    const d = new Date((val - 25569) * 86400 * 1000);
    // Adjust for timezone offset to keep UTC clean
    d.setMinutes(d.getMinutes() + d.getTimezoneOffset());
    return d;
  }
  if (typeof val === 'string') {
    const cleaned = val.trim();
    if (cleaned.toLowerCase() === 'date') return null;
    const parts = cleaned.split(/[\.\-\/]/);
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      let year = parseInt(parts[2], 10);
      if (parts[2].length === 2) {
        year += 2000;
      }
      return new Date(Date.UTC(year, month, day));
    }
  }
  const parsed = new Date(val);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Classify expenses
function classify(details, amount) {
  if (!details) return 'miscellaneous';
  const text = details.toLowerCase();
  
  if (text.includes('petrol') || text.includes('puncture') || text.includes('bike') || text.includes('fuel')) {
    return 'petrol';
  }
  if (text.includes('porter') || text.includes('vehicle') || text.includes('auto') || text.includes('loading') || text.includes('transport') || text.includes('v trans') || text.includes('baskar')) {
    return 'porter-vehicle';
  }
  if (text.includes('rice') || text.includes('dal') || text.includes('milk') || text.includes('biscuit') || text.includes('cake') || text.includes('ladoo') || text.includes('mixture') || text.includes('pups') || text.includes('coffee') || text.includes('grocery') || text.includes('welfare') || text.includes('tea') || text.includes('food')) {
    return 'staff-welfare';
  }
  if (text.includes('advance') || text.includes('salary') || text.includes('sannu') || text.includes('kunal') || text.includes('radhika') || text.includes('rishi') || text.includes('deepa') || text.includes('susheela') || text.includes('lalitha') || text.includes('boys room')) {
    return 'salary-advance';
  }
  if (text.includes('sir') || text.includes('mam') || text.includes('maam') || text.includes('owner') || text.includes('home expense')) {
    return 'sir-expenses';
  }
  return 'miscellaneous';
}

async function runSeeder() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected!');

    // 1. Clear database
    console.log('Clearing old collections...');
    await User.deleteMany({});
    await Labour.deleteMany({});
    await Attendance.deleteMany({});
    await CashTx.deleteMany({});
    await AdvanceRequest.deleteMany({});
    console.log('Collections cleared.');

    // 2. Create Users
    console.log('Creating users...');
    const hashedOwnerPwd = await bcrypt.hash('Owner123', 10);
    const hashedStaffPwd = await bcrypt.hash('Staff123', 10);

    const ownerUser = new User({
      username: 'owner',
      password: hashedOwnerPwd,
      name: 'MD',
      role: 'owner'
    });
    await ownerUser.save();

    const staffUser = new User({
      username: 'staff',
      password: hashedStaffPwd,
      name: 'Office Staff',
      role: 'staff'
    });
    await staffUser.save();

    const hashedStaff2Pwd = await bcrypt.hash('Staff123', 10);
    const staff2User = new User({
      username: 'staff2',
      password: hashedStaff2Pwd,
      name: 'Office Staff 2',
      role: 'staff2'
    });
    await staff2User.save();
    console.log('Users created: "owner" (Owner123), "staff" (Staff123), and "staff2" (Staff123).');

    // 3. Create Labourers
    console.log('Creating labourers...');
    const labourersData = [
      { name: 'Deepa', whatsapp: '9876543210', monthlySalary: 15000, imageUrl: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=200' },
      { name: 'Radhika', whatsapp: '9876543211', monthlySalary: 12000, imageUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=200' },
      { name: 'Sannu', whatsapp: '9876543212', monthlySalary: 14000, imageUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=200' },
      { name: 'Kunal Dalai', whatsapp: '9876543213', monthlySalary: 16000, imageUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&q=80&w=200' },
      { name: 'Trinath', whatsapp: '9876543214', monthlySalary: 13500, imageUrl: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&q=80&w=200' },
      { name: 'Gulshan', whatsapp: '9876543215', monthlySalary: 14500, imageUrl: 'https://images.unsplash.com/photo-1519345182560-3f2917c472ef?auto=format&fit=crop&q=80&w=200' },
      { name: 'Rishi', whatsapp: '9876543216', monthlySalary: 18000, imageUrl: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&q=80&w=200' }
    ];

    const labourMap = {};
    for (const data of labourersData) {
      const labour = new Labour(data);
      await labour.save();
      labourMap[data.name.toLowerCase()] = labour._id;
    }
    console.log('Labourers created successfully.');

    // 4. Load Excel file
    const excelPath = path.join(__dirname, '..', '2025-2026-Cash expenses dec to may till updated.xlsx');
    console.log('Reading Excel file:', excelPath);
    const workbook = xlsx.readFile(excelPath);

    // 5. Parse 'overall expenses'
    console.log("Parsing 'overall expenses'...");
    const expensesSheet = workbook.Sheets['overall expenses'];
    const expensesData = xlsx.utils.sheet_to_json(expensesSheet, { header: 1 });

    let importedTxs = 0;
    const txRecords = [];

    expensesData.forEach((row, index) => {
      if (index === 0) return; // skip header
      const dateVal = row[0];
      const receivedVal = row[1];
      const expenseVal = row[2];
      const details = row[3];

      const txDate = parseDate(dateVal);
      if (!txDate) return; // skip if invalid date or empty

      if (receivedVal !== undefined && receivedVal !== null && receivedVal !== '') {
        // Cash received from owner
        txRecords.push({
          txType: 'received',
          category: 'received',
          amount: Number(receivedVal),
          date: txDate,
          description: details || 'Received Cash from Owner',
          staffId: staffUser._id
        });
        importedTxs++;
      } else if (expenseVal !== undefined && expenseVal !== null && expenseVal !== '') {
        // Expense transaction
        const category = classify(details, Number(expenseVal));
        txRecords.push({
          txType: 'expense',
          category: category,
          amount: Number(expenseVal),
          date: txDate,
          description: details || '',
          staffId: staffUser._id
        });
        importedTxs++;
      }
    });

    if (txRecords.length > 0) {
      await CashTx.insertMany(txRecords);
      console.log(`Successfully imported ${importedTxs} cashbook transactions.`);
    }

    // 6. Parse 'Sheet4' for Deepa's attendance
    console.log("Parsing 'Sheet4' for Deepa's attendance...");
    const sheet4 = workbook.Sheets['Sheet4'];
    const sheet4Data = xlsx.utils.sheet_to_json(sheet4, { header: 1 });
    const deepaId = labourMap['deepa'];
    
    if (deepaId) {
      const attendanceRecords = [];

      sheet4Data.forEach((row, rIndex) => {
        // Helper to convert attendance value to status
        const getStatus = (val, isSun) => {
          if (val === 1 || val === '1' || val === 1.0) return 'present';
          if (val === 0.5 || val === '0.5') return 'half-day';
          if (val === 0 || val === '0' || val === 'absent') return 'absent';
          if (val === 'SUNDAY' || isSun) return 'sunday';
          return 'present'; // Default
        };

        // Block 1: March 2026
        // Col 1 is Date, Col 2 is Attendance
        if (row[1] !== undefined && row[1] !== '') {
          const marchDate = parseDate(row[1]);
          if (marchDate && marchDate.getMonth() === 2 && marchDate.getFullYear() === 2026) { // Month is 0-indexed (March is 2)
            const attVal = row[2];
            const isSun = marchDate.getDay() === 0;
            const status = getStatus(attVal, isSun);
            attendanceRecords.push({
              labourId: deepaId,
              date: marchDate,
              status: status,
              remarks: row[3] || row[4] || ''
            });
          }
        }

        // Block 2: April 2026 (Rows 51+, Col 3 is Date, Col 4 is Attendance)
        if (row[3] !== undefined && row[3] !== '') {
          const aprilDate = parseDate(row[3]);
          if (aprilDate && aprilDate.getMonth() === 3 && aprilDate.getFullYear() === 2026) { // April is 3
            const attVal = row[4];
            const isSun = aprilDate.getDay() === 0;
            const status = getStatus(attVal, isSun);
            attendanceRecords.push({
              labourId: deepaId,
              date: aprilDate,
              status: status,
              remarks: row[9] || ''
            });
          }
        }

        // Block 3: May 2026 (Rows 51+, Col 0 is Date, Col 1 is Attendance)
        if (row[0] !== undefined && row[0] !== '' && rIndex >= 51) {
          const mayDate = parseDate(row[0]);
          if (mayDate && mayDate.getMonth() === 4 && mayDate.getFullYear() === 2026) { // May is 4
            const attVal = row[1];
            const isSun = mayDate.getDay() === 0;
            const status = getStatus(attVal, isSun);
            attendanceRecords.push({
              labourId: deepaId,
              date: mayDate,
              status: status,
              remarks: row[2] || ''
            });
          }
        }
      });

      if (attendanceRecords.length > 0) {
        // Remove duplicates if any
        const uniqueRecordsMap = {};
        attendanceRecords.forEach(record => {
          const key = `${record.labourId}-${record.date.toISOString().slice(0, 10)}`;
          uniqueRecordsMap[key] = record;
        });

        const uniqueRecords = Object.values(uniqueRecordsMap);
        await Attendance.insertMany(uniqueRecords);
        console.log(`Successfully seeded ${uniqueRecords.length} attendance records for Deepa.`);
      }
    } else {
      console.log('Deepa was not found in database, skipped attendance seeding.');
    }

    console.log('Seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding error:', error);
    process.exit(1);
  }
}

runSeeder();
