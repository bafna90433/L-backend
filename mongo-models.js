const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['owner', 'staff', 'staff2'], required: true },
  whatsapp: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  upiId: { type: String, default: '' }
});

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

const AttendanceSchema = new mongoose.Schema({
  labourId: { type: mongoose.Schema.Types.ObjectId, ref: 'Labour', required: true },
  date: { type: Date, required: true },
  status: { type: String, enum: ['present', 'half-day', 'absent', 'sunday', 'permission'], required: true },
  checkIn: { type: Date, default: null },
  checkOut: { type: Date, default: null },
  punches: { type: [Date], default: [] },
  activeHours: { type: Number, default: 0 },
  awayHours: { type: Number, default: 0 },
  permissionHours: { type: Number, default: 0 },
  isPermissionApproved: { type: Boolean, default: false },
  overtimeHours: { type: Number, default: 0 },
  remarks: { type: String, default: '' }
});
AttendanceSchema.index({ labourId: 1, date: 1 }, { unique: true });

const CashTxSchema = new mongoose.Schema({
  txType: { type: String, enum: ['received', 'expense'], required: true },
  category: { type: String, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  description: { type: String, default: '' },
  paymentMode: { type: String, enum: ['online', 'handcash'], default: 'handcash' },
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  labourId: { type: mongoose.Schema.Types.ObjectId, ref: 'Labour', default: null }
});

const AdvanceRequestSchema = new mongoose.Schema({
  labourId: { type: mongoose.Schema.Types.ObjectId, ref: 'Labour', required: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  reason: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  deductedAmount: { type: Number, default: 0 },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  expenseTxId: { type: mongoose.Schema.Types.ObjectId, ref: 'CashTx', default: null }
});

const ReminderSchema = new mongoose.Schema({
  message: { type: String, required: true },
  targetDate: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'acknowledged', 'completed'], default: 'pending' },
  type: { type: String, enum: ['general', 'salary-delay', 'self'], default: 'general' },
  targetStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  acknowledgedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const TaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  taskType: { type: String, enum: ['regular', 'reminder-sir', 'custom'], default: 'custom' },
  frequency: { type: String, enum: ['daily', 'weekly', 'monthly', 'one-time'], default: 'one-time' },
  status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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
  seenByOwner: { type: Boolean, default: false },
  seenAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  mediaType: { type: String, enum: ['image', 'document', 'none'], default: 'none' },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const DepartmentSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});

const SystemSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
});

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

module.exports = {
  User: model('User', UserSchema),
  Labour: model('Labour', LabourSchema),
  Attendance: model('Attendance', AttendanceSchema),
  CashTx: model('CashTx', CashTxSchema),
  AdvanceRequest: model('AdvanceRequest', AdvanceRequestSchema),
  Reminder: model('Reminder', ReminderSchema),
  Task: model('Task', TaskSchema),
  Message: model('Message', MessageSchema),
  Department: model('Department', DepartmentSchema),
  SystemSettings: model('SystemSettings', SystemSettingsSchema)
};
