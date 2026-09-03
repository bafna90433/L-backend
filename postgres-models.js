const { PrismaClient } = require('@prisma/client');

const prisma = global.__labourPrisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.__labourPrisma = prisma;

const specs = {
  User: {
    delegate: 'user',
    fields: ['username', 'password', 'name', 'role', 'whatsapp', 'imageUrl', 'upiId', 'roleId', 'isActive', 'createdAt', 'updatedAt']
  },
  Labour: {
    delegate: 'labour',
    fields: ['name', 'whatsapp', 'monthlySalary', 'imageUrl', 'status', 'employeeType', 'department', 'phonePeNumber', 'upiId', 'phonePeQrUrl', 'faceEmbedding', 'workingHours', 'shiftStart', 'shiftEnd', 'gender', 'empCode', 'createdAt']
  },
  Attendance: {
    delegate: 'attendance',
    fields: ['labourId', 'date', 'status', 'checkIn', 'checkOut', 'punches', 'activeHours', 'awayHours', 'permissionHours', 'isPermissionApproved', 'overtimeHours', 'remarks'],
    populate: { labourId: { relation: 'labour', model: 'Labour' } }
  },
  CashTx: {
    delegate: 'cashTx',
    fields: ['txType', 'category', 'amount', 'date', 'description', 'paymentMode', 'staffId', 'labourId'],
    populate: {
      staffId: { relation: 'staff', model: 'User' },
      labourId: { relation: 'labour', model: 'Labour' }
    }
  },
  AdvanceRequest: {
    delegate: 'advanceRequest',
    fields: ['labourId', 'amount', 'date', 'reason', 'status', 'deductedAmount', 'requestedBy', 'approvedBy', 'expenseTxId'],
    populate: {
      labourId: { relation: 'labour', model: 'Labour' },
      requestedBy: { relation: 'requester', model: 'User' },
      approvedBy: { relation: 'approver', model: 'User' },
      expenseTxId: { relation: 'expenseTx', model: 'CashTx' }
    }
  },
  Reminder: {
    delegate: 'reminder',
    fields: ['message', 'targetDate', 'status', 'type', 'targetStaffId', 'createdBy', 'acknowledgedBy', 'acknowledgedAt', 'createdAt'],
    populate: {
      targetStaffId: { relation: 'targetStaff', model: 'User' },
      createdBy: { relation: 'creator', model: 'User' },
      acknowledgedBy: { relation: 'acknowledger', model: 'User' }
    }
  },
  Task: {
    delegate: 'task',
    fields: ['title', 'taskType', 'frequency', 'status', 'assignedTo', 'completedBy', 'completedAt', 'description', 'remarks', 'nextFollowup', 'comments', 'seenByOwner', 'seenAt', 'reminderDateTime', 'reminderAlarmArmed', 'reminderNote', 'createdAt'],
    populate: {
      assignedTo: { relation: 'assignee', model: 'User' },
      completedBy: { relation: 'completer', model: 'User' }
    }
  },
  Message: {
    delegate: 'message',
    fields: ['sender', 'receiver', 'text', 'mediaUrl', 'mediaType', 'isRead', 'createdAt'],
    populate: {
      sender: { relation: 'senderUser', model: 'User' },
      receiver: { relation: 'receiverUser', model: 'User' }
    }
  },
  Department: {
    delegate: 'department',
    fields: ['name', 'createdAt']
  },
  SystemSettings: {
    delegate: 'systemSetting',
    fields: ['key', 'value', 'updatedAt']
  },
  DeletedLog: {
    delegate: 'deletedLog',
    fields: ['originalId', 'itemType', 'category', 'txType', 'amount', 'paymentMode', 'date', 'description', 'taggedPerson', 'loggedByStaff', 'deletedBy', 'deletedByName', 'deletedAt'],
    populate: {
      deletedBy: { relation: 'deleter', model: 'User' }
    }
  }
};

const asId = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') return String(value._id || value.id || value);
  return String(value);
};

const translateWhere = (where = {}) => {
  if (!where || typeof where !== 'object' || where instanceof Date) return where;
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(where)) {
    const key = rawKey === '_id' ? 'id' : rawKey;
    if (rawKey === '$or') {
      result.OR = rawValue.map(translateWhere);
      continue;
    }
    if (rawKey === '$and') {
      result.AND = rawValue.map(translateWhere);
      continue;
    }
    if (rawValue && typeof rawValue === 'object' && !(rawValue instanceof Date) && !Array.isArray(rawValue)) {
      if (rawValue.$regex instanceof RegExp) {
        const pattern = rawValue.$regex.source.replace(/^\^/, '').replace(/\$$/, '');
        result[key] = { equals: pattern, mode: 'insensitive' };
        continue;
      }
      const operators = {};
      for (const [operator, value] of Object.entries(rawValue)) {
        if (operator === '$in') operators.in = value.map(item => key.endsWith('Id') || key === 'id' ? asId(item) : item);
        else if (operator === '$gte') operators.gte = value;
        else if (operator === '$lte') operators.lte = value;
        else if (operator === '$gt') operators.gt = value;
        else if (operator === '$lt') operators.lt = value;
        else if (operator === '$ne') operators.not = key.endsWith('Id') || key === 'id' ? asId(value) : value;
        else operators[operator] = value;
      }
      result[key] = operators;
    } else {
      result[key] = key.endsWith('Id') || key === 'id' || ['sender', 'receiver', 'requestedBy', 'approvedBy', 'createdBy', 'acknowledgedBy', 'assignedTo', 'completedBy'].includes(key)
        ? asId(rawValue)
        : rawValue;
    }
  }
  return result;
};

const translateSort = (sort = {}) => Object.entries(sort).map(([field, direction]) => ({
  [field === '_id' ? 'id' : field]: Number(direction) < 0 ? 'desc' : 'asc'
}));

const relationValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) return asId(value);
  return value;
};

const cleanData = (spec, input = {}, { includeId = false } = {}) => {
  const source = input.$set || input;
  const data = {};
  if (includeId && (source._id || source.id)) data.id = asId(source._id || source.id);
  for (const field of spec.fields) {
    if (source[field] === undefined) continue;
    const value = source[field];
    data[field] = field.endsWith('Id') || ['sender', 'receiver', 'requestedBy', 'approvedBy', 'createdBy', 'acknowledgedBy', 'assignedTo', 'completedBy'].includes(field)
      ? relationValue(value)
      : value;
  }
  return data;
};

const projectDocument = (doc, selection) => {
  if (!selection) return doc;
  const fields = selection.split(/\s+/).filter(Boolean);
  const exclusions = fields.filter(field => field.startsWith('-')).map(field => field.slice(1));
  const inclusions = fields.filter(field => !field.startsWith('-'));
  if (inclusions.length) {
    const projected = { _id: doc._id };
    for (const field of inclusions) if (field !== '_id' && doc[field] !== undefined) projected[field] = doc[field];
    return projected;
  }
  for (const field of exclusions) delete doc[field];
  return doc;
};

class PostgresDocument {
  constructor(modelName, row = {}, isNew = false, populated = {}) {
    Object.defineProperty(this, '__modelName', { value: modelName, writable: true, enumerable: false });
    Object.defineProperty(this, '__isNew', { value: isNew, writable: true, enumerable: false });
    this.__apply(row, populated);
  }

  __apply(row, populated = {}) {
    const spec = specs[this.__modelName];
    if (row.id !== undefined) this._id = String(row.id);
    for (const field of spec.fields) if (row[field] !== undefined) this[field] = row[field];
    for (const [field, options] of Object.entries(populated)) {
      const mapping = spec.populate?.[field];
      if (!mapping) continue;
      const related = row[mapping.relation];
      this[field] = related ? materialize(mapping.model, related, {}, options.selection) : null;
    }
  }

  async save() {
    const spec = specs[this.__modelName];
    const delegate = prisma[spec.delegate];
    const data = cleanData(spec, this);
    const row = this.__isNew
      ? await delegate.create({ data })
      : await delegate.update({ where: { id: this._id }, data });
    this.__isNew = false;
    this.__apply(row);
    return this;
  }

  toObject() {
    return this.toJSON();
  }

  toJSON() {
    const result = { _id: this._id };
    const spec = specs[this.__modelName];
    for (const field of spec.fields) {
      if (this[field] === undefined) continue;
      const value = this[field];
      result[field] = value instanceof PostgresDocument ? value.toJSON() : value;
    }
    return result;
  }
}

function materialize(modelName, row, populated = {}, selection = null) {
  if (!row) return null;
  const doc = new PostgresDocument(modelName, row, false, populated);
  return projectDocument(doc, selection);
}

class Query {
  constructor(modelName, operation, where = {}) {
    this.modelName = modelName;
    this.operation = operation;
    this.where = where;
    this.sortValue = null;
    this.selection = null;
    this.populated = {};
  }

  sort(value) { this.sortValue = value; return this; }
  select(value) { this.selection = value; return this; }
  populate(field, selection) { this.populated[field] = { selection }; return this; }

  async exec() {
    const spec = specs[this.modelName];
    const delegate = prisma[spec.delegate];
    const include = {};
    for (const [field, options] of Object.entries(this.populated)) {
      const mapping = spec.populate?.[field];
      if (!mapping) continue;
      if (options.selection) {
        const select = { id: true };
        for (const item of options.selection.split(/\s+/).filter(Boolean)) if (item !== '_id') select[item] = true;
        include[mapping.relation] = { select };
      } else include[mapping.relation] = true;
    }
    const options = { where: translateWhere(this.where) };
    if (Object.keys(include).length) options.include = include;
    if (this.sortValue) options.orderBy = translateSort(this.sortValue);

    if (this.operation === 'find') {
      const rows = await delegate.findMany(options);
      return rows.map(row => materialize(this.modelName, row, this.populated, this.selection));
    }
    const row = await delegate.findFirst(options);
    return materialize(this.modelName, row, this.populated, this.selection);
  }

  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
}

const findExisting = async (delegate, where) => delegate.findFirst({ where: translateWhere(where) });

const uniqueWhereForUpsert = (modelName, where) => {
  const translated = translateWhere(where);
  if (modelName === 'Attendance' && translated.labourId && translated.date) {
    return { labourId_date: { labourId: translated.labourId, date: translated.date } };
  }
  if (modelName === 'SystemSettings' && translated.key) return { key: translated.key };
  return null;
};

function createModel(modelName) {
  const spec = specs[modelName];
  const delegate = () => prisma[spec.delegate];

  function Model(data = {}) {
    return new PostgresDocument(modelName, { ...data, id: data._id || data.id }, true);
  }

  Model.find = (where = {}) => new Query(modelName, 'find', where);
  Model.findOne = (where = {}) => new Query(modelName, 'findOne', where);
  Model.findById = (id) => new Query(modelName, 'findOne', { _id: id });
  Model.create = async (data) => materialize(modelName, await delegate().create({ data: cleanData(spec, data, { includeId: true }) }));

  Model.findByIdAndUpdate = async (id, update, options = {}) => {
    const existing = await delegate().findUnique({ where: { id: asId(id) } });
    if (!existing) return null;
    const row = await delegate().update({ where: { id: existing.id }, data: cleanData(spec, update) });
    return options.new === false ? null : materialize(modelName, row);
  };

  Model.findOneAndUpdate = async (where, update, options = {}) => {
    const updateData = cleanData(spec, update);
    const uniqueWhere = options.upsert ? uniqueWhereForUpsert(modelName, where) : null;
    if (uniqueWhere) {
      const row = await delegate().upsert({
        where: uniqueWhere,
        update: updateData,
        create: { ...cleanData(spec, where), ...updateData }
      });
      return materialize(modelName, row);
    }
    const existing = await findExisting(delegate(), where);
    let row;
    if (existing) row = await delegate().update({ where: { id: existing.id }, data: updateData });
    else if (options.upsert) row = await delegate().create({ data: { ...cleanData(spec, where), ...updateData } });
    else return null;
    return materialize(modelName, row);
  };

  Model.findByIdAndDelete = async (id) => {
    const existing = await delegate().findUnique({ where: { id: asId(id) } });
    if (!existing) return null;
    return materialize(modelName, await delegate().delete({ where: { id: asId(id) } }));
  };

  Model.deleteOne = async (where) => {
    const existing = await findExisting(delegate(), where);
    if (!existing) return { deletedCount: 0 };
    await delegate().delete({ where: { id: existing.id } });
    return { deletedCount: 1 };
  };

  Model.deleteMany = async (where) => {
    const result = await delegate().deleteMany({ where: translateWhere(where) });
    return { deletedCount: result.count };
  };

  Model.updateMany = async (where, update) => {
    const result = await delegate().updateMany({ where: translateWhere(where), data: cleanData(spec, update) });
    return { modifiedCount: result.count };
  };

  Model.insertMany = async (docs) => {
    await delegate().createMany({ data: docs.map(doc => cleanData(spec, doc, { includeId: true })), skipDuplicates: true });
    return Model.find({});
  };

  Model.bulkWrite = async (operations) => {
    for (const operation of operations) {
      if (!operation.updateOne) continue;
      const { filter, update, upsert } = operation.updateOne;
      await Model.findOneAndUpdate(filter, update, { upsert, new: true });
    }
    return { ok: 1 };
  };

  Model.aggregate = async (pipeline) => {
    if (modelName !== 'Message') throw new Error(`Aggregate is not implemented for ${modelName}`);
    const match = pipeline.find(stage => stage.$match)?.$match || {};
    const rows = await delegate().groupBy({
      by: ['sender'],
      where: translateWhere(match),
      _count: { _all: true }
    });
    return rows.map(row => ({ _id: row.sender, count: row._count._all }));
  };

  return Model;
}

module.exports = {
  prisma,
  User: createModel('User'),
  Labour: createModel('Labour'),
  Attendance: createModel('Attendance'),
  CashTx: createModel('CashTx'),
  AdvanceRequest: createModel('AdvanceRequest'),
  Reminder: createModel('Reminder'),
  Task: createModel('Task'),
  Message: createModel('Message'),
  Department: createModel('Department'),
  SystemSettings: createModel('SystemSettings'),
  DeletedLog: createModel('DeletedLog'),
  __testing: { specs, translateWhere, cleanData, uniqueWhereForUpsert }
};
