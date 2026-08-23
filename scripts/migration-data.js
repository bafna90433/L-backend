const toId = (value) => value === null || value === undefined ? null : String(value._id || value);
const toDate = (value, fallback = null) => value ? new Date(value) : fallback;

const objectIdDate = (value) => {
  if (!value) return new Date(0);
  if (typeof value.getTimestamp === 'function') return value.getTimestamp();
  const text = String(value);
  return /^[a-f\d]{24}$/i.test(text) ? new Date(parseInt(text.slice(0, 8), 16) * 1000) : new Date(0);
};

const jsonSafe = (value) => {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    if (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId') return String(value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
};

function mapMongoData(source) {
  return {
    users: source.users.map(item => ({
      id: toId(item._id), username: item.username, password: item.password, name: item.name,
      role: item.role, whatsapp: item.whatsapp || '', imageUrl: item.imageUrl || '', upiId: item.upiId || ''
    })),
    labours: source.labours.map(item => ({
      id: toId(item._id), name: item.name, whatsapp: item.whatsapp || '', monthlySalary: Number(item.monthlySalary || 0),
      imageUrl: item.imageUrl || '', status: item.status || 'active', employeeType: item.employeeType || 'labourer',
      department: item.department || '', phonePeNumber: item.phonePeNumber || '', upiId: item.upiId || '',
      phonePeQrUrl: item.phonePeQrUrl || '', faceEmbedding: (item.faceEmbedding || []).map(Number),
      workingHours: Number(item.workingHours || 8), shiftStart: item.shiftStart || '08:30', shiftEnd: item.shiftEnd || '20:30',
      gender: item.gender || 'Male', empCode: item.empCode || '', createdAt: toDate(item.createdAt, objectIdDate(item._id))
    })),
    attendances: source.attendances.map(item => ({
      id: toId(item._id), labourId: toId(item.labourId), date: toDate(item.date), status: item.status,
      checkIn: toDate(item.checkIn), checkOut: toDate(item.checkOut), punches: (item.punches || []).map(value => new Date(value)),
      activeHours: Number(item.activeHours || 0), awayHours: Number(item.awayHours || 0),
      permissionHours: Number(item.permissionHours || 0), isPermissionApproved: Boolean(item.isPermissionApproved),
      overtimeHours: Number(item.overtimeHours || 0), remarks: item.remarks || ''
    })),
    cashTransactions: source.cashTransactions.map(item => ({
      id: toId(item._id), txType: item.txType, category: item.category, amount: Number(item.amount || 0),
      date: toDate(item.date), description: item.description || '', paymentMode: item.paymentMode || 'handcash',
      staffId: toId(item.staffId), labourId: toId(item.labourId)
    })),
    advanceRequests: source.advanceRequests.map(item => ({
      id: toId(item._id), labourId: toId(item.labourId), amount: Number(item.amount || 0), date: toDate(item.date),
      reason: item.reason || '', status: item.status || 'pending', deductedAmount: Number(item.deductedAmount || 0),
      requestedBy: toId(item.requestedBy), approvedBy: toId(item.approvedBy), expenseTxId: toId(item.expenseTxId)
    })),
    reminders: source.reminders.map(item => ({
      id: toId(item._id), message: item.message, targetDate: toDate(item.targetDate), status: item.status || 'pending',
      type: item.type || 'general', targetStaffId: toId(item.targetStaffId), createdBy: toId(item.createdBy),
      acknowledgedBy: toId(item.acknowledgedBy), acknowledgedAt: toDate(item.acknowledgedAt),
      createdAt: toDate(item.createdAt, objectIdDate(item._id))
    })),
    tasks: source.tasks.map(item => ({
      id: toId(item._id), title: item.title, taskType: item.taskType || 'custom', frequency: item.frequency || 'one-time',
      status: item.status || 'pending', assignedTo: toId(item.assignedTo), completedBy: toId(item.completedBy),
      completedAt: toDate(item.completedAt), description: item.description || '', remarks: item.remarks || '',
      nextFollowup: item.nextFollowup || '', comments: jsonSafe(item.comments || []), seenByOwner: Boolean(item.seenByOwner),
      seenAt: toDate(item.seenAt), createdAt: toDate(item.createdAt, objectIdDate(item._id))
    })),
    messages: source.messages.map(item => ({
      id: toId(item._id), sender: toId(item.sender), receiver: toId(item.receiver), text: item.text || '',
      mediaUrl: item.mediaUrl || '', mediaType: item.mediaType || 'none', isRead: Boolean(item.isRead),
      createdAt: toDate(item.createdAt, objectIdDate(item._id))
    })),
    departments: source.departments.map(item => ({
      id: toId(item._id), name: item.name, createdAt: toDate(item.createdAt, objectIdDate(item._id))
    })),
    systemSettings: source.systemSettings.map(item => ({
      id: toId(item._id), key: item.key, value: jsonSafe(item.value), updatedAt: toDate(item.updatedAt, objectIdDate(item._id))
    }))
  };
}

function validateReferences(data) {
  const userIds = new Set(data.users.map(item => item.id));
  const labourIds = new Set(data.labours.map(item => item.id));
  const cashTxIds = new Set(data.cashTransactions.map(item => item.id));
  const errors = [];
  const requireRef = (collection, id, allowed, field) => {
    if (id && !allowed.has(id)) errors.push(`${collection}.${field} references missing id ${id}`);
  };

  data.attendances.forEach(item => requireRef('Attendance', item.labourId, labourIds, 'labourId'));
  data.cashTransactions.forEach(item => {
    requireRef('CashTx', item.staffId, userIds, 'staffId');
    requireRef('CashTx', item.labourId, labourIds, 'labourId');
  });
  data.advanceRequests.forEach(item => {
    requireRef('AdvanceRequest', item.labourId, labourIds, 'labourId');
    requireRef('AdvanceRequest', item.requestedBy, userIds, 'requestedBy');
    requireRef('AdvanceRequest', item.approvedBy, userIds, 'approvedBy');
    requireRef('AdvanceRequest', item.expenseTxId, cashTxIds, 'expenseTxId');
  });
  data.reminders.forEach(item => {
    requireRef('Reminder', item.targetStaffId, userIds, 'targetStaffId');
    requireRef('Reminder', item.createdBy, userIds, 'createdBy');
    requireRef('Reminder', item.acknowledgedBy, userIds, 'acknowledgedBy');
  });
  data.tasks.forEach(item => {
    requireRef('Task', item.assignedTo, userIds, 'assignedTo');
    requireRef('Task', item.completedBy, userIds, 'completedBy');
  });
  data.messages.forEach(item => {
    requireRef('Message', item.sender, userIds, 'sender');
    requireRef('Message', item.receiver, userIds, 'receiver');
  });
  if (errors.length) throw new Error(`Reference validation failed before PostgreSQL writes:\n${errors.slice(0, 50).join('\n')}`);
}

function validateRequiredValues(data) {
  const errors = [];
  const required = {
    users: ['id', 'username', 'password', 'name', 'role'],
    labours: ['id', 'name', 'whatsapp', 'monthlySalary', 'createdAt'],
    attendances: ['id', 'labourId', 'date', 'status'],
    cashTransactions: ['id', 'txType', 'category', 'amount', 'date', 'staffId'],
    advanceRequests: ['id', 'labourId', 'amount', 'date', 'requestedBy'],
    reminders: ['id', 'message', 'targetDate', 'createdBy', 'createdAt'],
    tasks: ['id', 'title', 'createdAt'],
    messages: ['id', 'sender', 'receiver', 'createdAt'],
    departments: ['id', 'name', 'createdAt'],
    systemSettings: ['id', 'key', 'value', 'updatedAt']
  };

  for (const [collection, fields] of Object.entries(required)) {
    data[collection].forEach((item, index) => {
      for (const field of fields) {
        const value = item[field];
        if (value === null || value === undefined || value === '') {
          errors.push(`${collection}[${index}].${field} is required`);
        } else if (value instanceof Date && Number.isNaN(value.getTime())) {
          errors.push(`${collection}[${index}].${field} is not a valid date`);
        } else if (typeof value === 'number' && !Number.isFinite(value)) {
          errors.push(`${collection}[${index}].${field} is not a finite number`);
        }
      }
    });
  }

  const uniqueChecks = [
    ['users', item => item.username, 'username'],
    ['attendances', item => `${item.labourId}|${item.date.toISOString()}`, 'labourId/date'],
    ['departments', item => item.name.toLowerCase(), 'name'],
    ['systemSettings', item => item.key, 'key']
  ];
  for (const [collection, keyFor, label] of uniqueChecks) {
    const seen = new Set();
    for (const item of data[collection]) {
      const key = keyFor(item);
      if (seen.has(key)) errors.push(`${collection}.${label} has duplicate value ${key}`);
      seen.add(key);
    }
  }

  if (errors.length) throw new Error(`Required/unique validation failed before PostgreSQL writes:\n${errors.slice(0, 50).join('\n')}`);
}

const canonicalize = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
};

function compareDatasets(expectedRows, actualRows) {
  const expected = new Map(expectedRows.map(row => [row.id, JSON.stringify(canonicalize(row))]));
  // PostgreSQL may gain additive columns after the migration. Compare every
  // migrated field while ignoring only fields that never existed in MongoDB.
  const expectedById = new Map(expectedRows.map(row => [row.id, row]));
  const actual = new Map(actualRows.map(row => {
    const expectedRow = expectedById.get(row.id);
    const projected = expectedRow
      ? Object.fromEntries(Object.keys(expectedRow).map(key => [key, row[key]]))
      : row;
    return [row.id, JSON.stringify(canonicalize(projected))];
  }));
  const missingIds = [...expected.keys()].filter(id => !actual.has(id));
  const extraIds = [...actual.keys()].filter(id => !expected.has(id));
  const changedIds = [...expected.keys()].filter(id => actual.has(id) && expected.get(id) !== actual.get(id));
  return { matches: !missingIds.length && !extraIds.length && !changedIds.length, missingIds, extraIds, changedIds };
}

module.exports = { mapMongoData, validateReferences, validateRequiredValues, compareDatasets, canonicalize };
