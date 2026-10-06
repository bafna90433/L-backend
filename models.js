if ((process.env.DATABASE_PROVIDER || 'mongodb').toLowerCase() === 'postgresql') {
  module.exports = require('./postgres-models');
} else {
const mongoose = require('mongoose');

// User Schema
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  whatsapp: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  upiId: { type: String, default: '' }
});

// Labour Schema
const LabourSchema = new mongoose.Schema({
  name: { type: String, required: true },
  whatsapp: { type: String, default: '' },
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

// Attendance Schema
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

// Compound index to prevent duplicate attendance records for same labourer on same day
AttendanceSchema.index({ labourId: 1, date: 1 }, { unique: true });

// Cash Transactions Schema
const CashTxSchema = new mongoose.Schema({
  txType: { type: String, enum: ['received', 'expense'], required: true },
  category: { 
    type: String, 
    required: true 
  },
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  description: { type: String, default: '' },
  paymentMode: { type: String, enum: ['online', 'handcash'], default: 'handcash' },
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
  deductedAmount: { type: Number, default: 0 },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fundingStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  fundingStaffRef: { type: String, default: '' },
  fundingStaffName: { type: String, default: '' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  expenseTxId: { type: mongoose.Schema.Types.ObjectId, ref: 'CashTx', default: null }
});

// Reminder Schema
const ReminderSchema = new mongoose.Schema({
  message: { type: String, required: true },
  targetDate: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'acknowledged', 'completed'], default: 'pending' },
  type: { type: String, enum: ['general', 'salary-delay', 'self'], default: 'general' },
  targetStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null means all staff
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
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdByRole: { type: String, enum: ['owner', 'staff'], default: 'staff' },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completedAt: { type: Date, default: null },
  completionRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completionRequestedAt: { type: Date, default: null },
  description: { type: String, default: '' },
  language: { type: String, enum: ['en', 'hi', 'ta'], default: 'en' },
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
  reminderDateTime: { type: Date, default: null },
  reminderAlarmArmed: { type: Boolean, default: false },
  reminderNote: { type: String, default: '' },
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

// System Settings Schema
const SystemSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
});

// Deleted Logs Audit Schema
const DeletedLogSchema = new mongoose.Schema({
  originalId: { type: String, default: '' },
  itemType: { type: String, default: 'Cash Transaction' },
  category: { type: String, default: '' },
  txType: { type: String, default: 'expense' },
  amount: { type: Number, default: 0 },
  paymentMode: { type: String, default: 'handcash' },
  date: { type: Date, default: null },
  description: { type: String, default: '' },
  taggedPerson: { type: String, default: '' },
  loggedByStaff: { type: String, default: '' },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deletedByName: { type: String, default: '' },
  deletedAt: { type: Date, default: Date.now }
});

/* ---------------- Toy production ---------------- */

const ToyTypeSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const ToySchema = new mongoose.Schema({
  typeId: { type: mongoose.Schema.Types.ObjectId, ref: 'ToyType', required: true },
  name: { type: String, required: true },
  code: { type: String, default: '' },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const ToyProcessSchema = new mongoose.Schema({
  toyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Toy', required: true },
  name: { type: String, required: true },
  sortOrder: { type: Number, default: 0 },
  // Expected pieces an hour. 0 means no target has been set.
  targetPerHour: { type: Number, default: 0 },
  // What a whole shift should produce — the floor runs 8 and 12 hour shifts.
  target8h: { type: Number, default: 0 },
  target12h: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// One worker's day: when they came, when they left, and so how long they had.
const ProductionDaySchema = new mongoose.Schema({
  date: { type: Date, required: true },
  labourId: { type: mongoose.Schema.Types.ObjectId, ref: 'Labour', required: true },
  status: { type: String, enum: ['present', 'half', 'leave'], default: 'present' },
  inTime: { type: String, default: '' },
  outTime: { type: String, default: '' },
  breakMinutes: { type: Number, default: undefined },
  availableMinutes: { type: Number, default: 0 },
  note: { type: String, default: '' },
  enteredBy: { type: String, default: '' },
  enteredByName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

ProductionDaySchema.index({ date: 1, labourId: 1 }, { unique: true });

const ProductionEntrySchema = new mongoose.Schema({
  date: { type: Date, required: true },
  labourId: { type: mongoose.Schema.Types.ObjectId, ref: 'Labour', required: true },
  toyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Toy', required: true },
  processId: { type: mongoose.Schema.Types.ObjectId, ref: 'ToyProcess', required: true },
  minutes: { type: Number, default: 0 },
  pieces: { type: Number, default: 0 },
  note: { type: String, default: '' },
  workType: { type: String, default: 'regular' },
  enteredBy: { type: String, default: '' },
  enteredByName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

ProductionEntrySchema.index({ date: 1 });
ProductionEntrySchema.index({ labourId: 1 });

// Every change kept, so a corrected number can always be traced back.
const ProductionLogSchema = new mongoose.Schema({
  entryId: { type: String, default: '' },
  action: { type: String, required: true },
  summary: { type: String, default: '' },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  byName: { type: String, default: '' },
  at: { type: Date, default: Date.now }
});

// Damage is logged on its own, not against a production entry: a broken part
// is found in a box, long after whoever made it has moved on.
const DamageEntrySchema = new mongoose.Schema({
  date: { type: Date, required: true },
  toyName: { type: String, required: true },
  partName: { type: String, required: true },
  qty: { type: Number, default: 0 },
  enteredBy: { type: String, default: '' },
  enteredByName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
DamageEntrySchema.index({ date: 1 });

const ToyType = mongoose.model('ToyType', ToyTypeSchema);
const Toy = mongoose.model('Toy', ToySchema);
const ToyProcess = mongoose.model('ToyProcess', ToyProcessSchema);
const ProductionDay = mongoose.model('ProductionDay', ProductionDaySchema);
const ProductionEntry = mongoose.model('ProductionEntry', ProductionEntrySchema);
const ProductionLog = mongoose.model('ProductionLog', ProductionLogSchema);
const DamageEntry = mongoose.model('DamageEntry', DamageEntrySchema);

const SystemSettings = mongoose.model('SystemSettings', SystemSettingsSchema);
const DeletedLog = mongoose.model('DeletedLog', DeletedLogSchema);

module.exports = {
  User,
  Labour,
  Attendance,
  CashTx,
  AdvanceRequest,
  Reminder,
  Task,
  Message,
  Department,
  SystemSettings,
  DeletedLog,
  ToyType,
  Toy,
  ToyProcess,
  ProductionDay,
  ProductionEntry,
  ProductionLog,
  DamageEntry
};
}
