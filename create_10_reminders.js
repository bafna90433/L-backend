const mongoose = require('mongoose');
const { Reminder, User } = require('./models');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://Labour:Labour123@labour.ajkpera.mongodb.net/LabourManagement?retryWrites=true&w=majority';

async function seed10Reminders() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    let ownerUser = await User.findOne({ role: 'owner' });
    if (!ownerUser) {
      ownerUser = await User.findOne({});
    }

    if (!ownerUser) {
      console.error('No user found in DB! Creating default admin user...');
      ownerUser = await User.create({
        username: 'admin',
        password: 'password123',
        name: 'Admin Owner',
        role: 'owner'
      });
    }

    // Tomorrow's date: 2026-07-28
    const tomorrowBase = new Date(2026, 6, 28); // Month index 6 = July (0-indexed)

    const remindersList = [
      { msg: 'Review morning attendance & check-in list for factory staff', hour: 9, minute: 0 },
      { msg: 'Verify daily raw material stock & warehouse inventory report', hour: 10, minute: 0 },
      { msg: 'Approve pending advance requests for labourers', hour: 11, minute: 30 },
      { msg: 'Safety inspection & machine maintenance round in Production Unit', hour: 13, minute: 0 },
      { msg: 'Clear vendor payment invoices & cash register ledger', hour: 14, minute: 30 },
      { msg: 'Review shift wise overtime hours & production logs', hour: 16, minute: 0 },
      { msg: 'Weekly staff alignment call with plant supervisor', hour: 17, minute: 30 },
      { msg: 'Verify ZKTeco biometric sync data & attendance logs', hour: 18, minute: 30 },
      { msg: 'Prepare tomorrow\'s work allocation & dispatch schedule', hour: 19, minute: 30 },
      { msg: 'Final evening factory closing report & security verification', hour: 20, minute: 30 }
    ];

    const insertedDocs = [];
    for (const item of remindersList) {
      const targetDate = new Date(tomorrowBase);
      targetDate.setHours(item.hour, item.minute, 0, 0);

      const rem = new Reminder({
        message: item.msg,
        targetDate: targetDate,
        status: 'pending',
        type: 'general',
        createdBy: ownerUser._id
      });

      const saved = await rem.save();
      insertedDocs.push(saved);
      console.log(`Created reminder: "${saved.message}" for ${saved.targetDate.toISOString()}`);
    }

    console.log(`Successfully created ${insertedDocs.length} reminders for tomorrow (2026-07-28)!`);
    process.exit(0);
  } catch (err) {
    console.error('Error creating reminders:', err);
    process.exit(1);
  }
}

seed10Reminders();
