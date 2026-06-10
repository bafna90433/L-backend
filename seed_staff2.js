require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const xlsx = require('xlsx');
const path = require('path');
const { User, Task } = require('./models');

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/LabourManagement';

async function seedStaff2() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected!');

    // 1. Create or update user staff2
    console.log('Creating/updating office-staff2 user...');
    const hashedPwd = await bcrypt.hash('Staff123', 10);
    
    let staff2User = await User.findOne({ username: 'staff2' });
    if (staff2User) {
      staff2User.password = hashedPwd;
      staff2User.name = 'Office Staff 2';
      staff2User.role = 'staff2';
      await staff2User.save();
      console.log('User "staff2" updated successfully.');
    } else {
      staff2User = new User({
        username: 'staff2',
        password: hashedPwd,
        name: 'Office Staff 2',
        role: 'staff2'
      });
      await staff2User.save();
      console.log('User "staff2" created successfully.');
    }

    const staff2Id = staff2User._id;

    // 2. Clear old tasks assigned to staff2
    console.log('Clearing old tasks assigned to staff2...');
    await Task.deleteMany({ assignedTo: staff2Id });
    console.log('Old staff2 tasks cleared.');

    // 3. Load Excel file
    const excelPath = path.join(__dirname, '..', 'office-staff2', 'Daily Works & Followups.xls');
    console.log('Reading Excel file:', excelPath);
    const workbook = xlsx.readFile(excelPath);

    const tasksToInsert = [];

    // --- SHEET 1: Daily Works ---
    console.log("Parsing 'Sheet1' (Daily Works)...");
    const sheet1 = workbook.Sheets['Sheet1'];
    if (sheet1) {
      const sheet1Data = xlsx.utils.sheet_to_json(sheet1, { header: 1 });
      sheet1Data.forEach((row, index) => {
        if (index <= 1) return; // Skip title/header rows
        if (row.length === 0 || !row[1]) return; // Skip empty rows

        const heading = row[1];
        const overview = row[2] || '';
        const remarks = row[3] || '';
        const nextFollowup = row[4] || '';
        const rawStatus = row[5] || 'Pending';

        const status = (rawStatus.toLowerCase() === 'finished' || rawStatus.toLowerCase() === 'closed') 
          ? 'completed' 
          : 'pending';

        tasksToInsert.push({
          title: heading.toString().trim(),
          taskType: 'regular',
          frequency: 'one-time',
          status: status,
          assignedTo: staff2Id,
          description: overview.toString().trim(),
          remarks: remarks.toString().trim(),
          nextFollowup: nextFollowup.toString().trim(),
          completedAt: status === 'completed' ? new Date() : null
        });
      });
    }

    // --- SHEET 2: sir Reminders ---
    console.log("Parsing 'sir Reminders'...");
    const sirReminders = workbook.Sheets['sir Reminders'];
    if (sirReminders) {
      const sirRemindersData = xlsx.utils.sheet_to_json(sirReminders, { header: 1 });
      sirRemindersData.forEach((row, index) => {
        if (index === 0) return; // Skip header 'Reminders'
        if (row.length === 0 || !row[0]) return;

        tasksToInsert.push({
          title: row[0].toString().trim(),
          taskType: 'reminder-sir',
          frequency: 'one-time',
          status: 'pending',
          assignedTo: staff2Id,
          description: 'Reminder for Sir',
          remarks: '',
          nextFollowup: ''
        });
      });
    }

    // --- SHEET 3: LULU ---
    console.log("Parsing 'LULU'...");
    const luluSheet = workbook.Sheets['LULU'];
    if (luluSheet) {
      const luluData = xlsx.utils.sheet_to_json(luluSheet, { header: 1 });
      luluData.forEach((row, index) => {
        if (index === 0) return; // Skip headers
        if (row.length === 0 || !row[0]) return;

        const station = row[0];
        const remarks = row[1] || '';

        tasksToInsert.push({
          title: `LULU Station Followup - ${station.toString().trim()}`,
          taskType: 'custom',
          frequency: 'weekly',
          status: 'pending',
          assignedTo: staff2Id,
          description: `Followup with LULU station: ${station}`,
          remarks: remarks.toString().trim(),
          nextFollowup: ''
        });
      });
    }

    // --- SHEET 4: SPP ---
    console.log("Parsing 'SPP'...");
    const sppSheet = workbook.Sheets['SPP'];
    if (sppSheet) {
      const sppData = xlsx.utils.sheet_to_json(sppSheet, { header: 1 });
      sppData.forEach((row, index) => {
        if (index <= 3) return; // Skip headers
        if (row.length === 0 || !row[0]) return;

        const packType = row[0];
        const designByBafna = row[1] || 'NO';
        const artworkReceived = row[2] || 'NO';
        const approvedByBafna = row[3] || 'NO';
        const remark = row[4] || '';
        const totalDesign = row[5] || '';

        tasksToInsert.push({
          title: `SPP Design Artwork - ${packType.toString().trim()}`,
          taskType: 'custom',
          frequency: 'one-time',
          status: 'pending',
          assignedTo: staff2Id,
          description: `Design By Bafna: ${designByBafna} | Artwork Received Salem: ${artworkReceived} | Approved By Bafna: ${approvedByBafna} | Total Design: ${totalDesign}`,
          remarks: remark.toString().trim(),
          nextFollowup: ''
        });
      });
    }

    if (tasksToInsert.length > 0) {
      await Task.insertMany(tasksToInsert);
      console.log(`Seeded ${tasksToInsert.length} tasks for staff2 successfully!`);
      console.log(`- Regular works (Sheet1): ${tasksToInsert.filter(t => t.taskType === 'regular').length}`);
      console.log(`- Reminders for Sir: ${tasksToInsert.filter(t => t.taskType === 'reminder-sir').length}`);
      console.log(`- Custom followups (LULU/SPP): ${tasksToInsert.filter(t => t.taskType === 'custom').length}`);
    } else {
      console.log('No tasks found to seed.');
    }

    console.log('Seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding error:', error);
    process.exit(1);
  }
}

seedStaff2();
