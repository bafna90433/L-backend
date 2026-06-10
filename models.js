const mongoose = require('mongoose');

// User Schema
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['owner', 'staff', 'staff2'], required: true },
  whatsapp: { type: String, default: '' },
  imageUrl: { type: String, default: '' }
});

// Labour Schema
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
  createdAt: { type: Date, default: Date.now }
});

// Attendance Schema
const AttendanceSchema = new mongoose.Schema({
  labourId: { type: mongoose.Schema.Types.ObjectId, ref: 'Labour', required: true },
  date: { type: Date, required: true },
  status: { type: String, enum: ['present', 'half-day', 'absent', 'sunday', 'permission'], required: true },
  permissionHours: { type: Number, default: 0 },
  remarks: { type: String, default: '' }
});

// Compound index to prevent duplicate attendance records for same labourer on same day
AttendanceSchema.index({ labourId: 1, date: 1 }, { unique: true });

// Cash Transactions Schema
const CashTxSchema = new mongoose.Schema({
  txType: { type: String, enum: ['received', 'expense'], required: true },
  category: { 
    type: String, 
    enum: ['staff-welfare', 'petrol', 'porter-vehicle', 'miscellaneous', 'sir-expenses', 'salary-advance', 'received', 'salary-payment'],
    required: true 
  },
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  description: { type: String, default: '' },
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  labourId: { type: mongoose.Schema.Types.ObjectId, ref: 'Labour', default: null }
});

// Advance Request Schema
const AdvanceRequestSchema = new mongoose.Schema({
  labourId: { type: mongoose.Schema.Types.ObjectId, ref: 'Labour', required: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  reason: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  expenseTxId: { type: mongoose.Schema.Types.ObjectId, ref: 'CashTx', default: null }
});

// Reminder Schema
const ReminderSchema = new mongoose.Schema({
  message: { type: String, required: true },
  targetDate: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'acknowledged'], default: 'pending' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  acknowledgedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Labour = mongoose.model('Labour', LabourSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);
const CashTx = mongoose.model('CashTx', CashTxSchema);
const AdvanceRequest = mongoose.model('AdvanceRequest', AdvanceRequestSchema);
const Reminder = mongoose.model('Reminder', ReminderSchema);

// Task Schema
const TaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  taskType: { type: String, enum: ['regular', 'reminder-sir', 'custom'], default: 'custom' },
  frequency: { type: String, enum: ['daily', 'weekly', 'monthly', 'one-time'], default: 'one-time' },
  status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // Null means all staff
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completedAt: { type: Date, default: null },
  description: { type: String, default: '' },
  remarks: { type: String, default: '' },
  nextFollowup: { type: String, default: '' },
  comments: [{
    authorName: { type: String, required: true },
    authorRole: { type: String, required: true },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const Task = mongoose.model('Task', TaskSchema);

// Message Schema
const MessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  mediaType: { type: String, enum: ['image', 'document', 'none'], default: 'none' },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', MessageSchema);

// Department Schema
const DepartmentSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});

const Department = mongoose.model('Department', DepartmentSchema);

module.exports = {
  User,
  Labour,
  Attendance,
  CashTx,
  AdvanceRequest,
  Reminder,
  Task,
  Message,
  Department
};


