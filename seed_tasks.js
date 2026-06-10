require('dotenv').config();
const mongoose = require('mongoose');
const xlsx = require('xlsx');
const path = require('path');
const { User, Task } = require('./models');

const mongoUri = process.env.MONGO_URI || 'mongodb+srv://Labour:Labour123@labour.ajkpera.mongodb.net/LabourManagement?retryWrites=true&w=majority';

async function seedTasks() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected!');

    console.log('Clearing old tasks...');
    await Task.deleteMany({});

    // Find the default staff user to assign tasks to
    const staffUser = await User.findOne({ role: 'staff' });
    if (!staffUser) {
      console.error('Staff user not found. Please run seed.js first.');
      process.exit(1);
    }
    const staffId = staffUser._id;
    console.log(`Assigning tasks to staff user: ${staffUser.name} (${staffUser.username})`);

    const excelPath = path.join(__dirname, '..', 'My work list updation 2026.xlsx');
    console.log('Reading Excel file:', excelPath);
    const workbook = xlsx.readFile(excelPath);

    const sheet = workbook.Sheets['Sheet1'];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    const tasksToInsert = [];
    let isReminderForSirSection = false;

    data.forEach((row, index) => {
      // Check if we hit the 'Regular Reminder for sir' header
      if (row.length > 0 && (row[0] === 'Regular Reminder for sir' || row[1] === 'Regular Reminder for sir')) {
        isReminderForSirSection = true;
        return;
      }

      if (row.length === 0 || row[0] === undefined) {
        return;
      }

      // Check if this row is actually a header row or has no title
      const title = row[1];
      if (!title || typeof title !== 'string' || title.trim() === '') {
        return;
      }

      const cleanTitle = title.trim();

      if (isReminderForSirSection) {
        // Reminder for sir (usually monthly or 2-monthly)
        tasksToInsert.push({
          title: cleanTitle,
          taskType: 'reminder-sir',
          frequency: 'monthly',
          status: 'pending',
          assignedTo: staffId
        });
      } else {
        // Regular staff task
        let frequency = 'daily';
        const lowerTitle = cleanTitle.toLowerCase();
        if (lowerTitle.includes('every month') || lowerTitle.includes('monthly') || lowerTitle.includes('every month regularly') || lowerTitle.includes('each month')) {
          frequency = 'monthly';
        } else if (lowerTitle.includes('every week') || lowerTitle.includes('weekly') || lowerTitle.includes('monday') || lowerTitle.includes('tuesday')) {
          frequency = 'weekly';
        }

        tasksToInsert.push({
          title: cleanTitle,
          taskType: 'regular',
          frequency: frequency,
          status: 'pending',
          assignedTo: staffId
        });
      }
    });

    if (tasksToInsert.length > 0) {
      await Task.insertMany(tasksToInsert);
      console.log(`Seeded ${tasksToInsert.length} tasks successfully!`);
      console.log(`- Regular tasks: ${tasksToInsert.filter(t => t.taskType === 'regular').length}`);
      console.log(`- Reminders for Sir: ${tasksToInsert.filter(t => t.taskType === 'reminder-sir').length}`);
    } else {
      console.log('No tasks found to seed.');
    }

    console.log('Seeding tasks completed!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding tasks:', error);
    process.exit(1);
  }
}

seedTasks();
