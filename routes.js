const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const ImageKit = require('imagekit');
const { User, Labour, Attendance, CashTx, AdvanceRequest, Reminder, Task, Message, Department, SystemSettings, DeletedLog } = require('./models');

const { prisma } = require('./postgres-models');
const { PERMISSION_GROUPS, resolveUserAccess, permissionMiddleware, anyPermissionMiddleware } = require('./access-control');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const JWT_SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

const sendWhatsAppCloudMessage = async (to, message) => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  if (!accessToken || !phoneNumberId) {
    const error = new Error('WhatsApp Cloud API is not configured on the server');
    error.statusCode = 503;
    throw error;
  }
  const normalizedNumber = String(to || '').replace(/\D/g, '');
  if (!normalizedNumber) {
    const error = new Error('A valid WhatsApp number is required in your profile');
    error.statusCode = 400;
    throw error;
  }
  const response = await fetch(
    `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedNumber,
        type: 'text',
        text: { preview_url: false, body: String(message).slice(0, 4000) }
      })
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'WhatsApp delivery failed');
    error.statusCode = response.status;
    throw error;
  }
  return payload;
};

// Initialize ImageKit
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || 'public_LB0AyCgim15VO491kDtVm0Fo798=',
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || 'private_nRKX1cLNUCab5WJX4cWNCnWqk3U=',
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/rishii'
});

// Ensure virtual "Company Expenses" labourer exists in database
const ensureCompanyExpensesLabour = async () => {
  try {
    const existing = await Labour.findOne({ empCode: 'COMPANY' });
    if (!existing) {
      const companyLabour = new Labour({
        name: 'Company Expenses',
        whatsapp: 'Not Provided',
        monthlySalary: 0,
        status: 'active',
        employeeType: 'labourer',
        department: 'Company',
        empCode: 'COMPANY',
        imageUrl: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&q=80&w=100'
      });
      await companyLabour.save();
      console.log('Virtual Company Expenses labourer created.');
    }
  } catch (err) {
    console.error('Error ensuring Company Expenses labourer:', err);
  }
};
// Run after a short delay to ensure DB is connected
setTimeout(ensureCompanyExpensesLabour, 3000);

// Middleware for JWT authentication
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token required' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ message: 'User not found or token invalid' });
    }
    const access = await resolveUserAccess(user);
    if (!access.isActive) {
      return res.status(403).json({ message: 'Your account or assigned role is inactive. Contact the MD.' });
    }
    user.permissions = access.permissions;
    user.roleName = access.roleName;
    user.roleId = access.roleId;
    user.isActive = access.isActive;
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Middleware to check if user is Owner (Admin)
const ownerOnlyMiddleware = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ message: 'Access denied: Owners only' });
  }
  next();
};

// Auth Routes
router.post('/auth/register', async (req, res) => {
  try {
    const { username, password, name, role } = req.body;
    if (!username || !password || !name || !role) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: 'Username already exists' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword, name, role });
    await user.save();

    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password required' });
    }
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const access = await resolveUserAccess(user);
    if (!access.isActive) {
      return res.status(403).json({ message: 'Your account or assigned role is inactive. Contact the MD.' });
    }
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        whatsapp: user.whatsapp || '',
        imageUrl: user.imageUrl || '',
        upiId: user.upiId || '',
        roleId: access.roleId,
        roleName: access.roleName,
        permissions: access.permissions,
        isActive: access.isActive
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.get('/auth/me', authMiddleware, async (req, res) => {
  res.json({
    user: {
      ...req.user.toJSON(),
      roleId: req.user.roleId || null,
      roleName: req.user.roleName || req.user.role,
      permissions: req.user.permissions || [],
      isActive: req.user.isActive !== false
    }
  });
});

router.put('/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { name, whatsapp, imageUrl, upiId } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name !== undefined) user.name = name;
    if (whatsapp !== undefined) user.whatsapp = whatsapp;
    if (imageUrl !== undefined) user.imageUrl = imageUrl;
    if (upiId !== undefined) user.upiId = upiId;

    await user.save();
    const access = await resolveUserPermissions(user);

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        _id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        whatsapp: user.whatsapp || '',
        imageUrl: user.imageUrl || '',
        upiId: user.upiId || '',
        roleId: access.roleId,
        roleName: access.roleName,
        permissions: access.permissions,
        isActive: access.isActive
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/staff', authMiddleware, permissionMiddleware('staff.view'), async (req, res) => {
  try {
    const staffList = await User.find({ role: { $ne: 'owner' }, isActive: { $ne: false }, username: { $ne: 'dev123' } }).select('name username _id role roleId roleName permissions whatsapp imageUrl isActive');
    res.json(staffList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


router.put('/staff/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }
    const staffUser = await User.findById(req.params.id);
    if (!staffUser) {
      return res.status(404).json({ message: 'Staff user not found' });
    }
    if (staffUser.role === 'owner') {
      return res.status(400).json({ message: 'Only staff names can be updated' });
    }
    staffUser.name = name;
    await staffUser.save();
    res.json({ message: 'Staff name updated successfully', user: staffUser });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const normalizeRoleSlug = value => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const publicStaff = staff => ({
  id: staff.id,
  _id: staff.id,
  username: staff.username,
  name: staff.name,
  role: staff.role,
  roleId: staff.roleId,
  roleName: staff.roleRef?.name || staff.role,
  permissions: staff.roleRef?.permissions || [],
  whatsapp: staff.whatsapp || '',
  imageUrl: staff.imageUrl || '',
  upiId: staff.upiId || '',
  isActive: staff.isActive,
  createdAt: staff.createdAt
});

// MD-only dynamic role and staff management. Records are deactivated, never deleted.
router.get('/admin/access/permissions', authMiddleware, ownerOnlyMiddleware, (req, res) => {
  res.json({ groups: PERMISSION_GROUPS });
});

router.get('/admin/roles', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { users: true } } }
    });
    res.json(roles.map(role => ({ ...role, userCount: role._count.users, _count: undefined })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/admin/roles', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const slug = normalizeRoleSlug(req.body.slug || name);
    const description = String(req.body.description || '').trim();
    const validPermissions = new Set(PERMISSION_GROUPS.flatMap(group => group.permissions.map(item => item.key)));
    const permissions = [...new Set(Array.isArray(req.body.permissions) ? req.body.permissions : [])]
      .filter(permission => validPermissions.has(permission));
    if (!name || !slug) return res.status(400).json({ message: 'Role name is required' });
    if (['owner', 'staff', 'staff2'].includes(slug)) return res.status(400).json({ message: 'This system role slug is reserved' });
    const role = await prisma.role.create({
      data: { name, slug, description, permissions, isActive: req.body.isActive !== false }
    });
    res.status(201).json({ ...role, userCount: 0 });
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ message: 'A role with this slug already exists' });
    res.status(500).json({ message: error.message });
  }
});

router.put('/admin/roles/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const existing = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'Role not found' });
    if (existing.slug === 'owner') return res.status(400).json({ message: 'MD / Owner role is protected' });
    const validPermissions = new Set(PERMISSION_GROUPS.flatMap(group => group.permissions.map(item => item.key)));
    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim();
    if (req.body.description !== undefined) data.description = String(req.body.description).trim();
    if (req.body.permissions !== undefined) {
      if (!Array.isArray(req.body.permissions)) return res.status(400).json({ message: 'Permissions must be a list' });
      data.permissions = [...new Set(req.body.permissions)].filter(permission => validPermissions.has(permission));
    }
    if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
    if (!data.name && req.body.name !== undefined) return res.status(400).json({ message: 'Role name is required' });
    const role = await prisma.role.update({ where: { id: existing.id }, data });
    const userCount = await prisma.user.count({ where: { roleId: existing.id } });
    res.json({ ...role, userCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/admin/staff', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: { role: { not: 'owner' } },
      include: { roleRef: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
    });
    res.json(staff.map(publicStaff));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/admin/staff', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name || !username || password.length < 6 || !req.body.roleId) {
      return res.status(400).json({ message: 'Name, username, role and minimum 6-character password are required' });
    }
    const role = await prisma.role.findUnique({ where: { id: req.body.roleId } });
    if (!role || role.slug === 'owner' || !role.isActive) return res.status(400).json({ message: 'Select an active staff role' });
    const staff = await prisma.user.create({
      data: {
        name,
        username,
        password: await bcrypt.hash(password, 10),
        whatsapp: String(req.body.whatsapp || '').trim(),
        role: role.slug,
        roleId: role.id,
        isActive: req.body.isActive !== false
      },
      include: { roleRef: true }
    });
    res.status(201).json(publicStaff(staff));
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ message: 'Username already exists' });
    res.status(500).json({ message: error.message });
  }
});

router.put('/admin/staff/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.role === 'owner') return res.status(404).json({ message: 'Staff user not found' });
    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim();
    if (req.body.username !== undefined) data.username = String(req.body.username).trim().toLowerCase();
    if (req.body.whatsapp !== undefined) data.whatsapp = String(req.body.whatsapp).trim();
    if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
    if (req.body.password) {
      if (String(req.body.password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
      data.password = await bcrypt.hash(String(req.body.password), 10);
    }
    if (req.body.roleId !== undefined) {
      const role = await prisma.role.findUnique({ where: { id: req.body.roleId } });
      if (!role || role.slug === 'owner' || !role.isActive) return res.status(400).json({ message: 'Select an active staff role' });
      data.roleId = role.id;
      data.role = role.slug;
    }
    if (!data.name && req.body.name !== undefined) return res.status(400).json({ message: 'Staff name is required' });
    const staff = await prisma.user.update({ where: { id: existing.id }, data, include: { roleRef: true } });
    res.json(publicStaff(staff));
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ message: 'Username already exists' });
    res.status(500).json({ message: error.message });
  }
});

router.delete('/admin/staff/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'Staff user not found' });
    if (existing.role === 'owner') return res.status(400).json({ message: 'Cannot delete owner account' });

    const staffId = existing.id;

    // Delete dependent records in proper sequential order
    try {
      await prisma.chatGroupMember.deleteMany({ where: { userId: staffId } });
      await prisma.groupMessage.deleteMany({ where: { sender: staffId } });
      await prisma.chatGroup.deleteMany({ where: { createdBy: staffId } });
      await prisma.message.deleteMany({ where: { OR: [{ sender: staffId }, { receiver: staffId }] } });
      await prisma.task.deleteMany({ where: { OR: [{ assignedTo: staffId }, { completedBy: staffId }] } });
      await prisma.reminder.deleteMany({ where: { OR: [{ createdBy: staffId }, { targetStaffId: staffId }, { acknowledgedBy: staffId }] } });

      // Clear advance request expenseTx references before deleting cashTx
      await prisma.advanceRequest.updateMany({
        where: { OR: [{ requestedBy: staffId }, { approvedBy: staffId }] },
        data: { expenseTxId: null }
      });
      await prisma.advanceRequest.deleteMany({ where: { OR: [{ requestedBy: staffId }, { approvedBy: staffId }] } });
      await prisma.cashTx.deleteMany({ where: { staffId: staffId } });

      await prisma.user.delete({ where: { id: staffId } });
      return res.json({ message: 'Staff member deleted successfully' });
    } catch (dbErr) {
      console.error('Cascade delete error, falling back to account deactivation:', dbErr);
      // Fallback: If DB integrity constraints prevent hard deletion, deactivate account
      await prisma.user.update({
        where: { id: staffId },
        data: { isActive: false }
      });
      return res.json({ message: 'Staff account deactivated successfully.' });
    }
  } catch (error) {
    console.error('Delete staff main error:', error);
    res.status(500).json({ message: error.message || 'Could not delete staff member' });
  }
});

router.get('/owner', authMiddleware, async (req, res) => {
  try {
    let owner = await User.findOne({ role: 'owner', imageUrl: { $exists: true, $nin: ['', null] } }).select('name username _id whatsapp imageUrl');
    if (!owner) {
      owner = await User.findOne({ role: 'owner' }).select('name username _id whatsapp imageUrl');
    }
    if (!owner) return res.status(404).json({ message: 'Owner not found' });
    
    const ownerObj = owner.toObject ? owner.toObject() : owner;
    if (!ownerObj.imageUrl) {
      ownerObj.imageUrl = 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&q=80&w=200';
    }
    res.json(ownerObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ImageKit Auth Parameters
router.get('/imagekit/auth', authMiddleware, (req, res) => {
  try {
    const authenticationParameters = imagekit.getAuthenticationParameters();
    res.json(authenticationParameters);
  } catch (error) {
    console.error('ImageKit auth error:', error);
    res.status(500).json({ message: 'Failed to generate ImageKit authentication parameters' });
  }
});

// Labour Routes
router.get('/labours', authMiddleware, permissionMiddleware('labours.view'), async (req, res) => {
  try {
    const labours = await Labour.find().sort({ name: 1 });
    res.json(labours);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/labours', authMiddleware, permissionMiddleware('labours.manage'), async (req, res) => {
  try {
    const { name, whatsapp, monthlySalary, shiftStart, shiftEnd, gender, imageUrl, employeeType, department, phonePeNumber, upiId, phonePeQrUrl, empCode } = req.body;
    if (!name || !whatsapp || monthlySalary === undefined) {
      return res.status(400).json({ message: 'Name, WhatsApp, and Monthly Salary are required' });
    }

    // Calculate workingHours from shiftStart and shiftEnd
    let computedHours = 8;
    if (shiftStart && shiftEnd) {
      const [startH, startM] = shiftStart.split(':').map(Number);
      const [endH, endM] = shiftEnd.split(':').map(Number);
      let diff = (endH + endM / 60) - (startH + startM / 60);
      if (diff < 0) diff += 24; // Crosses midnight
      computedHours = Number(diff.toFixed(2));
    }

    const labour = new Labour({
      name, whatsapp, monthlySalary,
      shiftStart: shiftStart || '08:30',
      shiftEnd: shiftEnd || '20:30',
      workingHours: computedHours,
      gender: gender || 'Male',
      imageUrl, employeeType, department, phonePeNumber, upiId, phonePeQrUrl, empCode
    });
    await labour.save();
    res.status(201).json(labour);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/labours/:id', authMiddleware, permissionMiddleware('labours.manage'), async (req, res) => {
  try {
    const { name, whatsapp, monthlySalary, shiftStart, shiftEnd, gender, imageUrl, status, employeeType, department, phonePeNumber, upiId, phonePeQrUrl, empCode } = req.body;
    const labour = await Labour.findById(req.params.id);
    if (!labour) return res.status(404).json({ message: 'Labourer not found' });

    if (name) labour.name = name;
    if (whatsapp) labour.whatsapp = whatsapp;
    if (monthlySalary !== undefined) labour.monthlySalary = monthlySalary;

    if (gender !== undefined) labour.gender = gender;
    if (shiftStart !== undefined) labour.shiftStart = shiftStart;
    if (shiftEnd !== undefined) labour.shiftEnd = shiftEnd;

    // Recalculate workingHours if shift changes
    if (shiftStart !== undefined || shiftEnd !== undefined) {
      const start = shiftStart || labour.shiftStart;
      const end = shiftEnd || labour.shiftEnd;
      if (start && end) {
        const [startH, startM] = start.split(':').map(Number);
        const [endH, endM] = end.split(':').map(Number);
        let diff = (endH + endM / 60) - (startH + startM / 60);
        if (diff < 0) diff += 24;
        labour.workingHours = Number(diff.toFixed(2));
      }
    }

    if (imageUrl !== undefined) labour.imageUrl = imageUrl;
    if (status) labour.status = status;
    if (employeeType !== undefined) labour.employeeType = employeeType;
    if (department !== undefined) labour.department = department;
    if (phonePeNumber !== undefined) labour.phonePeNumber = phonePeNumber;
    if (upiId !== undefined) labour.upiId = upiId;
    if (phonePeQrUrl !== undefined) labour.phonePeQrUrl = phonePeQrUrl;
    if (empCode !== undefined) labour.empCode = empCode;

    await labour.save();
    res.json(labour);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/labours/:id', authMiddleware, permissionMiddleware('labours.manage'), async (req, res) => {
  try {
    const labour = await Labour.findByIdAndDelete(req.params.id);
    if (!labour) return res.status(404).json({ message: 'Labourer not found' });
    res.json({ message: 'Labourer deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Attendance Routes
router.get('/attendance', authMiddleware, permissionMiddleware('attendance.view'), async (req, res) => {
  try {
    const { labourId, month, year, startDate, endDate } = req.query;
    let query = {};

    if (labourId) {
      query.labourId = labourId;
    }

    if (month && year) {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0, 23, 59, 59);
      query.date = { $gte: start, $lte: end };
    } else if (startDate && endDate) {
      query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const records = await Attendance.find(query).sort({ date: 1 });
    res.json(records);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/attendance/bulk', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { records } = req.body; // Array of { labourId, date, status, remarks }
    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ message: 'Records array is required' });
    }

    const operations = records.map(record => {
      const parsedDate = new Date(record.date);
      // Strip time to store clean date
      parsedDate.setUTCHours(0, 0, 0, 0);

      return {
        updateOne: {
          filter: { labourId: record.labourId, date: parsedDate },
          update: {
            $set: {
              status: record.status,
              permissionHours: record.permissionHours || 0,
              remarks: record.remarks || ''
            }
          },
          upsert: true
        }
      };
    });

    await Attendance.bulkWrite(operations);
    res.json({ message: 'Attendance records updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Register Face Embedding for a Labourer
router.put('/labours/:id/face', authMiddleware, permissionMiddleware('labours.manage'), async (req, res) => {
  try {
    const { faceEmbedding } = req.body;
    if (!faceEmbedding || !Array.isArray(faceEmbedding) || faceEmbedding.length === 0) {
      return res.status(400).json({ message: 'faceEmbedding array is required' });
    }

    const labour = await Labour.findByIdAndUpdate(
      req.params.id,
      { $set: { faceEmbedding } },
      { new: true }
    );
    if (!labour) return res.status(404).json({ message: 'Labourer not found' });
    res.json({ message: 'Face embedding registered successfully', labour });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Mark Attendance for a single Labourer (Kiosk Mode)
router.post('/attendance/mark', authMiddleware, permissionMiddleware('attendance.manage'), async (req, res) => {
  try {
    const { labourId, status } = req.body;
    if (!labourId) {
      return res.status(400).json({ message: 'labourId is required' });
    }
    const recordStatus = status || 'present';

    // Strip time to store clean date (midnight UTC)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const record = await Attendance.findOneAndUpdate(
      { labourId, date: today },
      { $set: { status: recordStatus, permissionHours: 0, remarks: 'Marked via Face Recognition Kiosk' } },
      { upsert: true, new: true }
    );

    res.json({ message: 'Attendance marked successfully', record });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Bulk sync attendance logs from ZKTeco biometric machine
router.post('/attendance/zkteco-sync', async (req, res) => {
  try {
    const { token, punches } = req.body;
    const expectedToken = process.env.ZKTECO_SYNC_TOKEN || 'zkteco_secret_token_2026';
    if (token !== expectedToken) {
      return res.status(401).json({ message: 'Unauthorized sync request' });
    }

    if (!punches || !Array.isArray(punches)) {
      return res.status(400).json({ message: 'punches array is required' });
    }

    let successCount = 0;
    let errors = [];

    // Fetch all active labourers to map them quickly in-memory
    const activeLabourers = await Labour.find({ status: 'active' });

    for (const punch of punches) {
      const { empCode, first_name, last_name, punch_time, punch_state, terminal_sn } = punch;

      // 1. Try to find the labourer by empCode
      let labour = activeLabourers.find(l => l.empCode === String(empCode));

      // 2. Fallback to name search if empCode not set
      if (!labour && first_name) {
        const fullName = `${first_name} ${last_name || ''}`.trim().toLowerCase();
        labour = activeLabourers.find(l => l.name.trim().toLowerCase() === fullName);
      }

      if (!labour) {
        errors.push({ empCode, name: `${first_name} ${last_name || ''}`, error: 'Labourer not found in MongoDB' });
        continue;
      }

      // Convert punch_time to clean date (midnight UTC)
      const punchDate = new Date(punch_time);
      const cleanPunchDate = new Date(punch_time);
      cleanPunchDate.setUTCHours(0, 0, 0, 0);

      // Fetch existing record if any to get punches array and permission status
      let existingRecord = await Attendance.findOne({ labourId: labour._id, date: cleanPunchDate });

      let currentPunches = existingRecord ? [...existingRecord.punches] : [];

      // Add the new punch if not already present
      const punchTimeStr = punchDate.toISOString();
      const alreadyPunched = currentPunches.some(p => new Date(p).toISOString() === punchTimeStr);
      if (!alreadyPunched) {
        currentPunches.push(punchDate);
      }

      // Sort punches chronologically
      currentPunches.sort((a, b) => new Date(a) - new Date(b));

      // Calculate check-in, check-out, active hours, away hours
      const checkIn = currentPunches[0];
      const checkOut = currentPunches.length > 1 ? currentPunches[currentPunches.length - 1] : null;

      let activeMs = 0;

      for (let i = 0; i < currentPunches.length; i++) {
        if (i % 2 === 1) {
          activeMs += new Date(currentPunches[i]) - new Date(currentPunches[i - 1]);
        }
      }

      const activeHours = activeMs / (1000 * 60 * 60);
      const requiredHours = labour.workingHours || 8;

      let deficit = requiredHours - activeHours;
      if (deficit < 0) deficit = 0;

      const gpSetting = await SystemSettings.findOne({ key: 'grace_period' });
      const gracePeriodMinutes = gpSetting && gpSetting.value !== undefined ? Number(gpSetting.value) : 10;
      const gracePeriodHours = gracePeriodMinutes / 60;

      if (deficit <= gracePeriodHours) {
        deficit = 0;
      }

      const awayHours = deficit;

      let status = 'present';
      let isPermissionApproved = false;

      if (activeHours === 0) {
        status = 'absent';
      } else if (deficit > 0) {
        status = 'permission';
        isPermissionApproved = true; // Automatic Compulsory Permission
      }

      const overtimeHours = activeHours > requiredHours ? activeHours - requiredHours : 0;

      let remarks = `Marked via ZKTeco Machine (${terminal_sn || 'Biometric'})`;
      if (status === 'permission') {
        remarks = `Automatic Permission (${awayHours.toFixed(1)}h deducted)`;
      } else if (overtimeHours > 0) {
        remarks = `Present (OT: ${overtimeHours.toFixed(1)} hrs)`;
      }

      // Save update
      await Attendance.findOneAndUpdate(
        { labourId: labour._id, date: cleanPunchDate },
        {
          $set: {
            status,
            checkIn,
            checkOut,
            punches: currentPunches,
            activeHours,
            awayHours,
            permissionHours,
            isPermissionApproved,
            overtimeHours,
            remarks
          }
        },
        { upsert: true }
      );

      successCount++;
    }

    res.json({
      message: 'Sync completed',
      processed: punches.length,
      successCount,
      errors
    });
  } catch (error) {
    console.error('ZKTeco Sync Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Approve or Reject Permission for an attendance entry
router.post('/attendance/:id/permission', authMiddleware, permissionMiddleware('attendance.manage'), async (req, res) => {
  try {
    const { isApproved } = req.body;
    if (isApproved === undefined) {
      return res.status(400).json({ message: 'isApproved is required' });
    }

    const record = await Attendance.findById(req.params.id).populate('labourId');
    if (!record) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const requiredHours = (record.labourId && record.labourId.workingHours) ? record.labourId.workingHours : 8;

    record.isPermissionApproved = isApproved;

    // Recalculate status and effective hours based on new permission approval status
    const permissionHours = isApproved ? record.awayHours : 0;
    record.permissionHours = permissionHours;

    const effectiveHours = record.activeHours + permissionHours;

    let status = 'present';
    if (effectiveHours < requiredHours * 0.5) {
      status = 'absent';
    } else if (effectiveHours < requiredHours * 0.875) {
      status = 'half-day';
    }
    record.status = status;

    // Recalculate Overtime
    record.overtimeHours = effectiveHours > requiredHours ? effectiveHours - requiredHours : 0;

    // Recalculate Remarks
    if (isApproved && record.awayHours > 0) {
      record.remarks = `Present (Approved ${record.awayHours.toFixed(1)}h Permission)`;
    } else if (record.overtimeHours > 0) {
      record.remarks = `Present (OT: ${record.overtimeHours.toFixed(1)} hrs)`;
    } else {
      record.remarks = 'Marked via ZKTeco Machine';
    }

    await record.save();
    res.json({ message: 'Permission updated successfully', record });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Expense / Cash Book Routes
router.get('/expenses', authMiddleware, permissionMiddleware('expenses.view'), async (req, res) => {
  try {
    const { startDate, endDate, category, txType } = req.query;
    let query = {};

    if (startDate && endDate) {
      query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (category) {
      query.category = category;
    }
    if (txType) {
      query.txType = txType;
    }

    const txs = await CashTx.find(query)
      .populate('staffId', 'name username')
      .populate('labourId', 'name')
      .sort({ date: -1, _id: -1 });
    res.json(txs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/expenses/balance', authMiddleware, permissionMiddleware('expenses.view'), async (req, res) => {
  try {
    const txs = await CashTx.find();

    let totalReceived = 0;
    let totalSpent = 0;
    let onlineReceived = 0;
    let onlineSpent = 0;
    let handCashReceived = 0;
    let handCashSpent = 0;

    const categoryTotals = {
      'staff-welfare': 0,
      'petrol': 0,
      'porter-vehicle': 0,
      'sir-expenses': 0,
      'salary-advance': 0,
      'company-expenses': 0,
      'miscellaneous': 0
    };

    txs.forEach(tx => {
      if (tx.txType === 'received') {
        totalReceived += tx.amount;
        if (tx.paymentMode === 'online') {
          onlineReceived += tx.amount;
        } else {
          handCashReceived += tx.amount;
        }
      } else {
        totalSpent += tx.amount;
        if (tx.paymentMode === 'online') {
          onlineSpent += tx.amount;
        } else {
          handCashSpent += tx.amount;
        }
        if (categoryTotals[tx.category] !== undefined) {
          categoryTotals[tx.category] += tx.amount;
        }
      }
    });

    const activeBalance = totalReceived - totalSpent;
    const onlineBalance = onlineReceived - onlineSpent;
    const handCashBalance = handCashReceived - handCashSpent;

    res.json({
      totalReceived,
      totalSpent,
      activeBalance,
      onlineBalance,
      handCashBalance,
      categoryTotals
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Owner gives cash to office staff (received transaction)
router.post('/expenses/cash-received', authMiddleware, permissionMiddleware('expenses.create'), async (req, res) => {
  try {
    const { amount, date, description, staffId, paymentMode } = req.body;

    // If the creator is staff, force the receiver (staffId) to be themselves.
    // If owner, they can specify any staff member's ID.
    let targetStaffId = staffId;
    if (req.user.role !== 'owner') {
      targetStaffId = req.user._id;
    }

    if (!amount || !date || !targetStaffId) {
      return res.status(400).json({ message: 'Amount, date, and staffId are required' });
    }

    // Any active non-owner role can be selected as staff.
    const staffUser = await User.findById(targetStaffId);
    if (!staffUser || staffUser.role === 'owner' || staffUser.isActive === false) {
      return res.status(400).json({ message: 'Valid staff member must be selected to receive the cash' });
    }

    const tx = new CashTx({
      txType: 'received',
      category: 'received',
      amount,
      date: new Date(date),
      description: description || `Cash received from owner`,
      paymentMode: paymentMode || 'handcash',
      staffId: targetStaffId
    });

    await tx.save();
    res.status(201).json(tx);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Staff (or Owner) logs an expense
router.post('/expenses/log', authMiddleware, permissionMiddleware('expenses.create'), async (req, res) => {
  try {
    const { amount, date, category, description, labourId, advanceDeducted, newAdvanceGiven, paymentMode, staffId } = req.body;
    if (!amount || !date || !category) {
      return res.status(400).json({ message: 'Amount, date, and category are required' });
    }

    if (category === 'received') {
      return res.status(400).json({ message: 'Invalid category for expense' });
    }

    const targetStaffId = staffId || req.user._id;

    const tx = new CashTx({
      txType: 'expense',
      category,
      amount,
      date: new Date(date),
      description: description || '',
      paymentMode: paymentMode || 'handcash',
      staffId: targetStaffId,
      labourId: labourId || null
    });

    await tx.save();


    // If it's a salary payment and advance is deducted, update the AdvanceRequests
    if (category === 'salary-payment' && labourId && advanceDeducted && parseFloat(advanceDeducted) > 0) {
      let remainingToDeduct = parseFloat(advanceDeducted);

      // Find all approved advances for this labourer
      const approvedAdvances = await AdvanceRequest.find({
        labourId,
        status: 'approved'
      }).sort({ date: 1 }); // oldest first

      for (const adv of approvedAdvances) {
        if (remainingToDeduct <= 0) break;

        const currentDeducted = adv.deductedAmount || 0;
        const availableToDeduct = adv.amount - currentDeducted;

        if (availableToDeduct > 0) {
          const deductNow = Math.min(remainingToDeduct, availableToDeduct);
          adv.deductedAmount = currentDeducted + deductNow;
          remainingToDeduct -= deductNow;
          await adv.save();
        }
      }
    }

    // If a new advance is given during salary payment, create a new approved AdvanceRequest
    if (category === 'salary-payment' && labourId && newAdvanceGiven && parseFloat(newAdvanceGiven) > 0) {
      const newAdvAmount = parseFloat(newAdvanceGiven);
      const newAdvRequest = new AdvanceRequest({
        labourId,
        amount: newAdvAmount,
        date: new Date(date || Date.now()),
        reason: 'Given during salary payment',
        status: 'approved',
        requestedBy: req.user._id,
        approvedBy: req.user._id,
        expenseTxId: tx._id // Link to this salary payment transaction
      });
      await newAdvRequest.save();
    }

    res.status(201).json(tx);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Edit a cash transaction (CashTx)
router.put('/expenses/:id', authMiddleware, permissionMiddleware('expenses.manage'), async (req, res) => {
  try {
    const { amount, date, category, description, paymentMode } = req.body;

    // Staff can only edit their own logs unless they are the owner
    let query = { _id: req.params.id };
    if (req.user.role !== 'owner') {
      query.staffId = req.user._id;
    }

    const tx = await CashTx.findOne(query);
    if (!tx) {
      return res.status(404).json({ message: 'Transaction not found or unauthorized' });
    }

    // Apply updates
    if (req.body.txType !== undefined) {
      tx.txType = req.body.txType;
    }
    if (amount !== undefined) tx.amount = Number(amount);
    if (date !== undefined) tx.date = new Date(date);

    if (tx.txType === 'received') {
      tx.category = 'received';
    } else if (category !== undefined) {
      tx.category = category;
    }

    if (description !== undefined) tx.description = description;
    if (paymentMode !== undefined) tx.paymentMode = paymentMode;

    await tx.save();
    res.json({ message: 'Transaction updated successfully', transaction: tx });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete a cash transaction (CashTx)
router.delete('/expenses/:id', authMiddleware, permissionMiddleware('expenses.manage'), async (req, res) => {
  try {
    // Staff can only delete their own logs unless they are the owner
    let query = { _id: req.params.id };
    if (req.user.role !== 'owner') {
      query.staffId = req.user._id;
    }

    const tx = await CashTx.findOne(query)
      .populate('staffId', 'name username')
      .populate('labourId', 'name');
    if (!tx) {
      return res.status(404).json({ message: 'Transaction not found or unauthorized' });
    }

    // Save to DeletedLog audit
    try {
      const deletedRecord = new DeletedLog({
        originalId: tx._id ? tx._id.toString() : '',
        itemType: 'Cash Transaction',
        category: tx.category || 'general',
        txType: tx.txType || 'expense',
        amount: tx.amount || 0,
        paymentMode: tx.paymentMode || 'handcash',
        date: tx.date || new Date(),
        description: tx.description || '',
        taggedPerson: tx.labourId?.name || '',
        loggedByStaff: tx.staffId?.name || '',
        deletedBy: req.user._id,
        deletedByName: req.user.name || req.user.username || 'Staff',
        deletedAt: new Date()
      });
      await deletedRecord.save();
    } catch (auditErr) {
      console.error('Failed to write deleted log audit:', auditErr);
    }

    await CashTx.deleteOne({ _id: req.params.id });
    res.json({ message: 'Transaction deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Fetch all deleted logs for audit
router.get('/deleted-logs', authMiddleware, permissionMiddleware('expenses.view'), async (req, res) => {
  try {
    const logs = await DeletedLog.find()
      .populate('deletedBy', 'name username role')
      .sort({ deletedAt: -1, _id: -1 });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Advance Requests Routes
router.post('/advances/request', authMiddleware, permissionMiddleware('advances.create'), async (req, res) => {
  try {
    const { labourId, amount, date, reason } = req.body;
    if (!labourId || !amount || !date) {
      return res.status(400).json({ message: 'Labourer ID, amount, and date are required' });
    }

    // Verify labourer exists
    const labour = await Labour.findById(labourId);
    if (!labour) return res.status(404).json({ message: 'Labourer not found' });

    const isCompanyExpense = labour.empCode === 'COMPANY' || labour.name === 'Company Expenses';

    if (!isCompanyExpense) {
      // Check if there is already an outstanding approved or pending advance
      const activeAdvances = await AdvanceRequest.find({
        labourId,
        status: { $in: ['pending', 'approved'] }
      });

      const outstandingAdvanceExists = activeAdvances.some(adv => {
        if (adv.status === 'pending') return true;
        if (adv.status === 'approved' && (adv.amount - (adv.deductedAmount || 0)) > 0) return true;
        return false;
      });

      if (outstandingAdvanceExists) {
        return res.status(400).json({
          message: 'This employee already has a pending request or an active outstanding advance balance.'
        });
      }
    }

    let autoApproveLimit = 0;
    const limitSetting = await SystemSettings.findOne({ key: 'advance_auto_approval_limit' });
    if (limitSetting && limitSetting.value !== undefined) {
      autoApproveLimit = Number(limitSetting.value);
    }

    const isAutoApproved = parseFloat(amount) <= autoApproveLimit;

    const request = new AdvanceRequest({
      labourId,
      amount,
      date: new Date(date),
      reason: reason || '',
      status: isAutoApproved ? 'approved' : 'pending',
      requestedBy: req.user._id,
      approvedBy: isAutoApproved ? req.user._id : undefined
    });

    await request.save();

    if (isAutoApproved) {
      // Create the CashTx transaction since it is auto-approved
      // If it's a company expense request, it is an INFLOW (received cash) for the staff!
      const tx = new CashTx({
        txType: isCompanyExpense ? 'received' : 'expense',
        category: isCompanyExpense ? 'received' : 'salary-advance',
        amount: parseFloat(amount),
        date: new Date(date || Date.now()),
        description: isCompanyExpense
          ? `Cash received for Company Expenses (Auto-Approved). Reason: ${reason || ''}`
          : `Advance paid to ${labour.name} (Auto-Approved). Reason: ${reason || ''}`,
        staffId: req.user._id,
        labourId: isCompanyExpense ? null : labourId,
        advanceRequestId: request._id
      });
      await tx.save();

      // Update the request with the transaction ID
      request.expenseTxId = tx._id;
      await request.save();
    }

    res.status(201).json(request);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

router.post('/advances/direct', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { labourId, amount, date, reason } = req.body;
    if (!labourId || !amount) {
      return res.status(400).json({ message: 'Labourer ID and amount are required' });
    }

    const labour = await Labour.findById(labourId);
    if (!labour) return res.status(404).json({ message: 'Labourer not found' });

    // Create the CashTx expense
    const tx = new CashTx({
      txType: 'expense',
      category: 'salary-advance',
      amount: parseFloat(amount),
      date: new Date(date || Date.now()),
      description: `Direct advance paid to ${labour.name} (By Owner). Reason: ${reason || 'Direct Advance'}`,
      staffId: req.user._id,
      labourId
    });
    await tx.save();

    // Create and save approved AdvanceRequest
    const request = new AdvanceRequest({
      labourId,
      amount: parseFloat(amount),
      date: new Date(date || Date.now()),
      reason: reason || 'Direct Advance',
      status: 'approved',
      requestedBy: req.user._id,
      approvedBy: req.user._id,
      expenseTxId: tx._id
    });
    await request.save();

    res.status(201).json({ message: 'Direct advance recorded successfully', request });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/advances', authMiddleware, permissionMiddleware('advances.view'), async (req, res) => {
  try {
    const { status, labourId } = req.query;
    let query = {};
    if (status) query.status = status;
    if (labourId) query.labourId = labourId;

    // Staff can see all, Owner can see all
    const requests = await AdvanceRequest.find(query)
      .populate('labourId', 'name whatsapp monthlySalary imageUrl')
      .populate('requestedBy', 'name username role upiId')
      .populate('approvedBy', 'name username role')
      .sort({ date: -1 });

    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/advances/:id/approve', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const request = await AdvanceRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Advance request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request has already been processed' });
    }

    const { paymentMode } = req.body;

    // Populate labourer details to write transaction description
    const labour = await Labour.findById(request.labourId);
    const isCompanyExpense = labour && (labour.empCode === 'COMPANY' || labour.name === 'Company Expenses');

    // Create the CashTx transaction
    const tx = new CashTx({
      txType: isCompanyExpense ? 'received' : 'expense',
      category: isCompanyExpense ? 'received' : 'salary-advance',
      amount: request.amount,
      date: request.date,
      description: isCompanyExpense
        ? `Cash received for Company Expenses (Approved by Owner). Reason: ${request.reason}`
        : `Advance paid to ${labour ? labour.name : 'Labourer'} (Approved by Owner). Reason: ${request.reason}`,
      staffId: request.requestedBy, // Logged under the staff who requested it
      labourId: isCompanyExpense ? null : request.labourId,
      paymentMode: paymentMode || 'handcash'
    });
    await tx.save();

    // Update the request
    request.status = 'approved';
    request.approvedBy = req.user._id;
    request.expenseTxId = tx._id;
    await request.save();

    res.json({ message: 'Advance request approved', request });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/advances/:id/reject', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const request = await AdvanceRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Advance request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request has already been processed' });
    }

    request.status = 'rejected';
    request.approvedBy = req.user._id;
    await request.save();

    res.json({ message: 'Advance request rejected', request });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Reminder Routes
router.post('/automation/whatsapp', authMiddleware, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ message: 'Message is required' });
    const result = await sendWhatsAppCloudMessage(req.user.whatsapp, message);
    res.json({
      sent: true,
      messageId: result?.messages?.[0]?.id || null
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

router.get('/reminders', authMiddleware, permissionMiddleware('reminders.view'), async (req, res) => {
  try {
    let query = {};
    if (req.user.role === 'owner') {
      // Owner sees everything including staff personal reminders
      query = {};
    } else {
      // Staff sees general reminders assigned to them or all, plus their own self reminders
      query = {
        $or: [
          { targetStaffId: req.user._id, type: { $ne: 'self' } },
          { targetStaffId: null, type: { $ne: 'self' } },
          { createdBy: req.user._id, type: 'self' }
        ]
      };
    }

    const reminders = await Reminder.find(query)
      .populate('createdBy', 'name username')
      .populate('acknowledgedBy', 'name username')
      .populate('targetStaffId', 'name username')
      .sort({ createdAt: -1 });
    res.json(reminders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Self Reminder Route (For staff)
router.post('/reminders/self', authMiddleware, permissionMiddleware('reminders.view'), async (req, res) => {
  try {
    const { message, targetDate } = req.body;
    if (!message || !targetDate) {
      return res.status(400).json({ message: 'Message and target date are required' });
    }
    const reminder = new Reminder({
      message,
      targetDate,
      type: 'self',
      createdBy: req.user._id
    });
    await reminder.save();

    const populated = await Reminder.findById(reminder._id)
      .populate('createdBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/reminders/self/:id', authMiddleware, permissionMiddleware('reminders.view'), async (req, res) => {
  try {
    const reminder = await Reminder.findOne({ _id: req.params.id, createdBy: req.user._id, type: 'self' });
    if (!reminder) return res.status(404).json({ message: 'Reminder not found or unauthorized' });
    await Reminder.findByIdAndDelete(req.params.id);
    res.json({ message: 'Self reminder deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/reminders/self/:id', authMiddleware, permissionMiddleware('reminders.view'), async (req, res) => {
  try {
    const { message, targetDate } = req.body;
    if (!message && !targetDate) {
      return res.status(400).json({ message: 'At least one field (message or targetDate) is required to update' });
    }
    const reminder = await Reminder.findOne({ _id: req.params.id, createdBy: req.user._id, type: 'self' });
    if (!reminder) return res.status(404).json({ message: 'Personal reminder not found or unauthorized' });

    if (message) reminder.message = message;
    if (targetDate) reminder.targetDate = new Date(targetDate);
    await reminder.save();

    res.json({ message: 'Personal reminder updated successfully', reminder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/reminders', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { message, targetDate, type, targetStaffId } = req.body;
    if (!message || !targetDate) {
      return res.status(400).json({ message: 'Message and Target Date are required' });
    }

    const reminder = new Reminder({
      message,
      targetDate: new Date(targetDate),
      type: type || 'general',
      targetStaffId: targetStaffId || null,
      createdBy: req.user._id
    });

    await reminder.save();
    res.status(201).json(reminder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/reminders/:id/acknowledge', authMiddleware, permissionMiddleware('reminders.view'), async (req, res) => {
  try {
    const reminder = await Reminder.findById(req.params.id);
    if (!reminder) return res.status(404).json({ message: 'Reminder not found' });

    const { targetDate } = req.body;
    if (targetDate) reminder.targetDate = new Date(targetDate);

    reminder.status = 'acknowledged';
    reminder.acknowledgedBy = req.user._id;
    reminder.acknowledgedAt = new Date();
    await reminder.save();

    res.json({ message: 'Reminder acknowledged successfully', reminder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Staff can update the targetDate of an acknowledged reminder (reschedule alarm)
router.post('/reminders/:id/update-date', authMiddleware, permissionMiddleware('reminders.view'), async (req, res) => {
  try {
    const reminder = await Reminder.findById(req.params.id);
    if (!reminder) return res.status(404).json({ message: 'Reminder not found' });

    const { targetDate } = req.body;
    if (!targetDate) return res.status(400).json({ message: 'targetDate is required' });

    reminder.targetDate = new Date(targetDate);
    await reminder.save();

    res.json({ message: 'Reminder date updated successfully', reminder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Staff stops alarm - marks reminder completed so it never rings again
router.post('/reminders/:id/stop-alarm', authMiddleware, permissionMiddleware('reminders.view'), async (req, res) => {
  try {
    const reminder = await Reminder.findById(req.params.id);
    if (!reminder) return res.status(404).json({ message: 'Reminder not found' });

    reminder.status = 'completed';
    reminder.completedAt = new Date();
    reminder.completedBy = req.user._id;
    await reminder.save();

    res.json({ message: 'Alarm stopped and reminder marked completed', reminder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/reminders/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { message, targetDate, targetStaffId } = req.body;
    const reminder = await Reminder.findById(req.params.id);
    if (!reminder) return res.status(404).json({ message: 'Reminder not found' });

    if (message) reminder.message = message;
    if (targetDate) reminder.targetDate = new Date(targetDate);
    if (targetStaffId !== undefined) reminder.targetStaffId = targetStaffId || null;

    await reminder.save();
    res.json(reminder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/reminders/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const reminder = await Reminder.findByIdAndDelete(req.params.id);
    if (!reminder) return res.status(404).json({ message: 'Reminder not found' });
    res.json({ message: 'Reminder deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Helper for task auto-reset
function checkAndResetTask(task) {
  if (task.status !== 'completed' || !task.completedAt) return false;

  const actualNow = new Date();
  const actualComp = new Date(task.completedAt);

  // Shift the logical day start to 8:30 AM by subtracting 8 hours and 30 minutes.
  // This means 08:29 AM real-time is treated as 23:59 the previous logical day,
  // and 08:30 AM real-time is treated as 00:00 of the new logical day.
  // For 'regular' tasks, they should reset exactly at 12 midnight (00:00 local time).
  const offsetMs = task.taskType === 'regular' ? 0 : (8 * 60 + 30) * 60 * 1000; // 8.5 hours in milliseconds
  const now = new Date(actualNow.getTime() - offsetMs);
  const comp = new Date(actualComp.getTime() - offsetMs);

  let shouldReset = false;
  if (task.frequency === 'daily') {
    shouldReset = now.toDateString() !== comp.toDateString();
  } else if (task.frequency === 'weekly') {
    const oneDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.floor((now - comp) / oneDay);
    if (diffDays >= 7) {
      shouldReset = true;
    } else {
      const getStartOfWeek = (d) => {
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const start = new Date(d);
        start.setDate(diff);
        start.setHours(0, 0, 0, 0);
        return start;
      };
      shouldReset = getStartOfWeek(now).getTime() !== getStartOfWeek(comp).getTime();
    }
  } else if (task.frequency === 'monthly') {
    shouldReset = now.getMonth() !== comp.getMonth() || now.getFullYear() !== comp.getFullYear();
  }

  if (shouldReset) {
    task.status = 'pending';
    task.completedBy = null;
    task.completedAt = null;
    return true;
  }
  return false;
}

// Task Routes
router.get('/tasks', authMiddleware, anyPermissionMiddleware(['tasks.view', 'work.dashboard.view']), async (req, res) => {
  try {
    const taskFilter = req.user.role === 'owner' ? {} : { assignedTo: req.user._id };
    const tasks = await Task.find(taskFilter)
      .populate('assignedTo', 'name username imageUrl')
      .populate('createdBy', 'name username role imageUrl')
      .populate('completedBy', 'name username imageUrl')
      .sort({ taskType: 1, createdAt: -1 });

    let updated = false;
    for (let task of tasks) {
      if (task.title && (task.title.startsWith('📌 Task:') || task.title.includes('Action Required:'))) {
        const clean = task.title.split('•')[0].replace(/^📌\s*Task:\s*/i, '').trim();
        if (clean) {
          task.title = clean;
          await task.save();
        }
      }
      if (checkAndResetTask(task)) {
        await task.save();
        updated = true;
      }
    }

    if (updated) {
      const refreshedTasks = await Task.find(taskFilter)
        .populate('assignedTo', 'name username imageUrl')
        .populate('createdBy', 'name username role imageUrl')
        .populate('completedBy', 'name username imageUrl')
        .sort({ taskType: 1, createdAt: -1 });
      return res.json(refreshedTasks);
    }

    res.json(tasks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/tasks', authMiddleware, anyPermissionMiddleware(['tasks.manage', 'tasks.create']), async (req, res) => {
  try {
    const { title, taskType, frequency, assignedTo, description, remarks, nextFollowup, createdByRole, language } = req.body;
    if (!title) {
      return res.status(400).json({ message: 'Task title is required' });
    }

    // If the creator is not an owner, automatically assign it to themselves
    let finalAssignedTo = assignedTo;
    if (req.user.role !== 'owner') {
      finalAssignedTo = req.user._id;
    }

    const effectiveRole = req.user.role === 'owner' ? 'owner' : (createdByRole || 'staff');
    let finalDesc = description || '';
    if (language && !finalDesc.includes('[lang:')) {
      finalDesc = `[lang:${language}] ${finalDesc}`.trim();
    }

    const task = new Task({
      title,
      taskType: taskType || 'custom',
      frequency: frequency || 'one-time',
      assignedTo: finalAssignedTo || null,
      createdBy: req.user._id,
      createdByRole: effectiveRole,
      description: finalDesc,
      remarks: remarks || '',
      nextFollowup: nextFollowup || '',
      seenByOwner: req.user.role === 'owner',
      seenAt: req.user.role === 'owner' ? new Date() : null
    });
    await task.save();

    let populated;
    try {
      populated = await Task.findById(task._id)
        .populate('assignedTo', 'name username')
        .populate('completedBy', 'name username');
    } catch (e) {
      populated = task;
    }
    res.status(201).json(populated || task);
  } catch (error) {
    console.error('Task creation error:', error);
    res.status(500).json({ message: error.message });
  }
});

router.post('/tasks/:id/complete', authMiddleware, anyPermissionMiddleware(['tasks.manage', 'tasks.edit']), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    task.status = 'completed';
    task.completedBy = req.user._id;
    task.completedAt = new Date();
    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name username')
      .populate('createdBy', 'name username role')
      .populate('completedBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/tasks/:id/seen', authMiddleware, permissionMiddleware('tasks.view'), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    if (req.user.role === 'owner') {
      task.seenByOwner = true;
      task.seenAt = new Date();
      await task.save();
    }

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name username')
      .populate('createdBy', 'name username role')
      .populate('completedBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/tasks/:id/reset', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    task.status = 'pending';
    task.completedBy = null;
    task.completedAt = null;
    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name username')
      .populate('createdBy', 'name username role')
      .populate('completedBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/tasks/:id/comment', authMiddleware, anyPermissionMiddleware(['tasks.manage', 'tasks.edit']), async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ message: 'Comment text is required' });

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    task.comments.push({
      authorName: req.user.name,
      authorRole: req.user.role,
      text,
      createdAt: new Date()
    });
    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name username')
      .populate('createdBy', 'name username role')
      .populate('completedBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/tasks/:id', authMiddleware, anyPermissionMiddleware(['tasks.manage', 'tasks.edit']), async (req, res) => {
  try {
    const { title, taskType, frequency, assignedTo, description, remarks, nextFollowup, language } = req.body;
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const isOwner = req.user.role === 'owner';
    const isMDTask = task.createdByRole === 'owner' || task.taskType === 'reminder-sir';

    // Staff cannot edit title/taskType/frequency of MD-assigned tasks
    if (!isOwner && isMDTask && (title !== undefined || taskType !== undefined || frequency !== undefined)) {
      return res.status(403).json({ message: 'Tasks assigned by MD cannot be edited by staff. Only remarks and follow-up notes can be updated.' });
    }

    if (isOwner || !isMDTask) {
      if (title !== undefined) task.title = title;
      if (taskType !== undefined) task.taskType = taskType;
      if (frequency !== undefined) task.frequency = frequency;
    }

    if (isOwner) {
      if (assignedTo !== undefined) task.assignedTo = assignedTo;
    }

    if (language !== undefined) {
      task.language = language;
    }

    if (description !== undefined) {
      let finalDesc = description;
      if (language && !finalDesc.startsWith('[lang:')) {
        finalDesc = `[lang:${language}] ${finalDesc.replace(/\[lang:(en|hi|ta)\]\s*/g, '').trim()}`;
      }
      task.description = finalDesc;
    } else if (language) {
      const currentDesc = (task.description || '').replace(/\[lang:(en|hi|ta)\]\s*/g, '').trim();
      task.description = `[lang:${language}] ${currentDesc}`;
    }

    if (remarks !== undefined) task.remarks = remarks;
    if (nextFollowup !== undefined) task.nextFollowup = nextFollowup;

    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name username')
      .populate('createdBy', 'name username role')
      .populate('completedBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/tasks/:id', authMiddleware, anyPermissionMiddleware(['tasks.manage', 'tasks.delete']), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const isOwner = req.user.role === 'owner';
    const isMDTask = task.createdByRole === 'owner' || task.taskType === 'reminder-sir';

    if (!isOwner && isMDTask) {
      return res.status(403).json({ message: 'Tasks assigned by MD cannot be deleted by staff' });
    }

    await Task.findByIdAndDelete(req.params.id);
    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});



// ==========================================================================
// GEMINI AI INTEGRATION ENDPOINTS
// ==========================================================================
router.post('/ai/chat', authMiddleware, async (req, res) => {
  try {
    const { prompt, systemInstruction } = req.body;
    if (!prompt) return res.status(400).json({ message: 'Prompt is required' });

    const apiKey = process.env.GEMINI_API_KEY || '';
    const models = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-pro'];
    let replyText = null;
    let lastError = null;

    if (apiKey) {
      for (const model of models) {
        try {
          const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: systemInstruction || `You are OfficePro AI corporate task management assistant. Refine task title and instructions clearly.` },
                    { text: prompt }
                  ]
                }
              ],
              generationConfig: { temperature: 0.7, maxOutputTokens: 1000 }
            })
          });

          if (response.ok) {
            const data = await response.json();
            replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (replyText) break;
          } else {
            lastError = await response.text();
          }
        } catch (e) {
          lastError = e.message;
        }
      }
    }

    // Smart fallback if API key is invalid/expired
    if (!replyText) {
      console.warn('Gemini API unreachable or key invalid. Using Smart AI Task Refiner fallback. Error:', lastError);

      const cleanPrompt = prompt.replace(/^User request:\s*/i, '').replace(/^Refine and improve.*?"(.*)"$/i, '$1').trim();
      const words = cleanPrompt.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      replyText = words;
    }

    res.json({ reply: replyText });
  } catch (error) {
    console.error('Gemini integration error:', error);
    res.status(500).json({ message: error.message || 'Gemini AI server error' });
  }
});

// PUBLIC TASK ANNOUNCEMENTS (FOR LOGGED-OUT SCREEN ALERTS)
router.get('/public/task-announcements', async (req, res) => {
  try {
    const tasks = await Task.find()
      .populate('assignedTo', 'name username role')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const sanitized = tasks.map(t => ({
      _id: t._id,
      title: t.title,
      description: t.description || '',
      assignedToName: t.assignedTo?.name || 'Staff Member',
      createdAt: t.createdAt
    }));

    res.json(sanitized);
  } catch (error) {
    console.error('Public announcement error:', error);
    res.status(500).json({ message: error.message });
  }
});

// REAL HUMAN NEURAL VOICE GENERATOR ENDPOINT (MULTI-LANGUAGE: EN, HI, TA - 100% STUDIO MALE VOICE)
router.post('/ai/tts', async (req, res) => {
  try {
    const { text, lang = 'en', voice } = req.body;
    if (!text) return res.status(400).json({ message: 'Text is required' });

    // Determine appropriate Male Neural Voice based on language
    let defaultVoice = 'en-US-AndrewNeural';
    let googleLang = 'en';

    if (lang === 'hi') {
      defaultVoice = 'hi-IN-MadhurNeural';
      googleLang = 'hi';
    } else if (lang === 'ta') {
      defaultVoice = 'ta-IN-ValluvarNeural';
      googleLang = 'ta';
    }

    const selectedVoice = voice || defaultVoice;

    // Strategy 1: Microsoft Neural 24kHz HD Male Voice
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(selectedVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text);

      const chunks = [];
      await new Promise((resolve, reject) => {
        audioStream.on('data', chunk => chunks.push(chunk));
        audioStream.on('end', resolve);
        audioStream.on('error', reject);
      });

      const audioBuffer = Buffer.concat(chunks);
      if (audioBuffer && audioBuffer.length > 100) {
        const base64 = audioBuffer.toString('base64');
        return res.json({
          audioContent: base64,
          mimeType: 'audio/mp3',
          type: 'neural-hd-human-voice',
          lang: googleLang
        });
      }
    } catch (edgeErr) {
      console.warn(`Neural HD Voice error for ${selectedVoice}:`, edgeErr.message);
    }

    // Strategy 2: Google Natural Audio Engine (Language specific)
    const encodedText = encodeURIComponent(text.slice(0, 300));
    const audioUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=${googleLang}&client=tw-ob`;
    const audioRes = await fetch(audioUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (audioRes.ok) {
      const buffer = await audioRes.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return res.json({ audioContent: base64, mimeType: 'audio/mp3', type: 'natural', lang: googleLang });
    }

    res.status(500).json({ message: 'Unable to stream natural voice' });
  } catch (error) {
    console.error('TTS endpoint error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Message / Chat Routes
const chatUserSelect = { id: true, name: true, username: true, role: true, imageUrl: true };

router.get('/chat/users', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    await prisma.user.updateMany({
      where: { username: { in: ['dev123', 'rishi'] } },
      data: { isActive: false }
    }).catch(() => { });

    const users = await prisma.user.findMany({
      where: { isActive: true, username: { notIn: ['dev123', 'rishi'] } },
      select: { ...chatUserSelect, isActive: true },
      orderBy: { name: 'asc' }
    });
    res.json(users.filter(user => user.id !== req.user._id.toString() && user.isActive !== false));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


router.get('/chat/groups', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const groups = await prisma.chatGroup.findMany({
      where: { members: { some: { userId } } },
      include: {
        members: { include: { user: { select: chatUserSelect } }, orderBy: { joinedAt: 'asc' } },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: { senderUser: { select: chatUserSelect } }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    const result = await Promise.all(groups.map(async group => {
      const membership = group.members.find(member => member.userId === userId);
      const unreadCount = await prisma.groupMessage.count({
        where: {
          groupId: group.id,
          sender: { not: userId },
          ...(membership?.lastReadAt ? { createdAt: { gt: membership.lastReadAt } } : {})
        }
      });
      return { ...group, lastMessage: group.messages[0] || null, messages: undefined, unreadCount };
    }));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/chat/groups', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const name = String(req.body.name || '').trim();
    const requestedMembers = Array.isArray(req.body.memberIds) ? req.body.memberIds.map(String) : [];
    if (name.length < 2) return res.status(400).json({ message: 'Group name must be at least 2 characters' });

    const memberIds = [...new Set([userId, ...requestedMembers])];
    const activeUsers = await prisma.user.findMany({ where: { id: { in: memberIds }, isActive: true }, select: { id: true } });
    const activeIds = activeUsers.map(user => user.id);
    if (!activeIds.includes(userId) || activeIds.length < 2) {
      return res.status(400).json({ message: 'Select at least one active group member' });
    }

    const group = await prisma.chatGroup.create({
      data: {
        name,
        description: String(req.body.description || '').trim(),
        avatarUrl: String(req.body.avatarUrl || ''),
        createdBy: userId,
        members: { create: activeIds.map(id => ({ userId: id, isAdmin: id === userId, lastReadAt: new Date() })) }
      },
      include: { members: { include: { user: { select: chatUserSelect } } } }
    });
    res.status(201).json({ ...group, unreadCount: 0, lastMessage: null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add member(s) to chat group
router.post('/chat/groups/:groupId/members', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const currentUserId = req.user._id.toString();
    const { groupId } = req.params;
    const memberIdsToAdd = Array.isArray(req.body.memberIds)
      ? req.body.memberIds.map(String)
      : (req.body.userId ? [String(req.body.userId)] : []);

    if (memberIdsToAdd.length === 0) {
      return res.status(400).json({ message: 'Select at least one member to add' });
    }

    const group = await prisma.chatGroup.findUnique({
      where: { id: groupId },
      include: { members: true }
    });

    if (!group) return res.status(404).json({ message: 'Group not found' });

    const currentMember = group.members.find(m => m.userId === currentUserId);
    const isOwner = req.user.role === 'owner';
    const isCreator = group.createdBy === currentUserId;
    const isAdmin = currentMember?.isAdmin;

    if (!isOwner && !isCreator && !isAdmin) {
      return res.status(403).json({ message: 'Only group admins or MD can add members' });
    }

    const existingUserIds = new Set(group.members.map(m => m.userId));
    const newMemberIds = memberIdsToAdd.filter(id => !existingUserIds.has(id));

    if (newMemberIds.length === 0) {
      return res.status(400).json({ message: 'Selected user(s) are already members of this group' });
    }

    const activeUsers = await prisma.user.findMany({
      where: { id: { in: newMemberIds }, isActive: true },
      select: { id: true }
    });

    const validNewIds = activeUsers.map(u => u.id);

    if (validNewIds.length > 0) {
      await prisma.chatGroupMember.createMany({
        data: validNewIds.map(id => ({
          groupId,
          userId: id,
          isAdmin: false,
          lastReadAt: new Date()
        }))
      });
    }

    const updatedGroup = await prisma.chatGroup.findUnique({
      where: { id: groupId },
      include: {
        members: { include: { user: { select: chatUserSelect } }, orderBy: { joinedAt: 'asc' } },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: { senderUser: { select: chatUserSelect } }
        }
      }
    });

    res.json({ ...updatedGroup, lastMessage: updatedGroup?.messages[0] || null, messages: undefined });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Remove member from chat group
router.delete('/chat/groups/:groupId/members/:targetUserId', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const currentUserId = req.user._id.toString();
    const { groupId, targetUserId } = req.params;

    const group = await prisma.chatGroup.findUnique({
      where: { id: groupId },
      include: { members: true }
    });

    if (!group) return res.status(404).json({ message: 'Group not found' });

    const currentMember = group.members.find(m => m.userId === currentUserId);
    const isOwner = req.user.role === 'owner';
    const isCreator = group.createdBy === currentUserId;
    const isAdmin = currentMember?.isAdmin;
    const isSelf = currentUserId === targetUserId;

    if (!isOwner && !isCreator && !isAdmin && !isSelf) {
      return res.status(403).json({ message: 'Only group admins or MD can remove members' });
    }

    const memberToRemove = group.members.find(m => m.userId === targetUserId);
    if (!memberToRemove) {
      return res.status(404).json({ message: 'Member is not in this group' });
    }

    await prisma.chatGroupMember.delete({
      where: { id: memberToRemove.id }
    });

    const updatedGroup = await prisma.chatGroup.findUnique({
      where: { id: groupId },
      include: {
        members: { include: { user: { select: chatUserSelect } }, orderBy: { joinedAt: 'asc' } },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: { senderUser: { select: chatUserSelect } }
        }
      }
    });

    res.json({ ...updatedGroup, lastMessage: updatedGroup?.messages[0] || null, messages: undefined });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


router.get('/chat/groups/:groupId/messages', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const membership = await prisma.chatGroupMember.findUnique({
      where: { groupId_userId: { groupId: req.params.groupId, userId } }
    });
    if (!membership) return res.status(403).json({ message: 'You are not a member of this group' });

    const messages = await prisma.groupMessage.findMany({
      where: { groupId: req.params.groupId },
      include: { senderUser: { select: chatUserSelect } },
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    await prisma.chatGroupMember.update({ where: { id: membership.id }, data: { lastReadAt: new Date() } });
    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/chat/groups/:groupId/messages', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const membership = await prisma.chatGroupMember.findUnique({
      where: { groupId_userId: { groupId: req.params.groupId, userId } },
      include: { group: { include: { members: { select: { userId: true } } } } }
    });
    if (!membership) return res.status(403).json({ message: 'You are not a member of this group' });

    const text = String(req.body.text || '').trim();
    const mediaUrl = String(req.body.mediaUrl || '');
    if (!text && !mediaUrl) return res.status(400).json({ message: 'Message or attachment is required' });
    const memberIds = new Set(membership.group.members.map(member => member.userId));
    const mentions = (Array.isArray(req.body.mentions) ? req.body.mentions.map(String) : []).filter(id => memberIds.has(id));

    const message = await prisma.groupMessage.create({
      data: {
        groupId: req.params.groupId,
        sender: userId,
        text,
        mediaUrl,
        mediaType: String(req.body.mediaType || 'none'),
        mentions: [...new Set(mentions)]
      },
      include: { senderUser: { select: chatUserSelect } }
    });
    await prisma.$transaction([
      prisma.chatGroup.update({ where: { id: req.params.groupId }, data: { updatedAt: new Date() } }),
      prisma.chatGroupMember.update({ where: { id: membership.id }, data: { lastReadAt: new Date() } })
    ]);
    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/messages/unread/count', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const unreadCounts = await Message.aggregate([
      { $match: { receiver: req.user._id, isRead: false } },
      { $group: { _id: '$sender', count: { $sum: 1 } } }
    ]);
    const countsMap = {};
    unreadCounts.forEach(item => {
      countsMap[item._id.toString()] = item.count;
    });
    res.json(countsMap);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/messages/:userId', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    const messages = await Message.find({
      $or: [
        { sender: req.user._id, receiver: targetUserId },
        { sender: targetUserId, receiver: req.user._id }
      ]
    }).sort({ createdAt: 1 });

    // Mark as read
    await Message.updateMany(
      { sender: targetUserId, receiver: req.user._id, isRead: false },
      { $set: { isRead: true } }
    );

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/messages', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const { receiverId, text, mediaUrl, mediaType } = req.body;
    if (!receiverId) {
      return res.status(400).json({ message: 'Receiver ID is required' });
    }

    const message = new Message({
      sender: req.user._id,
      receiver: receiverId,
      text: text || '',
      mediaUrl: mediaUrl || '',
      mediaType: mediaType || 'none'
    });

    await message.save();
    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/messages/:userId', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const targetId = req.params.userId;
    const currentUserId = req.user._id;

    // Delete all messages between current user and target user
    await Message.deleteMany({
      $or: [
        { sender: currentUserId, receiver: targetId },
        { sender: targetId, receiver: currentUserId }
      ]
    });

    res.json({ message: 'Chat cleared successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Single direct message delete
router.delete('/messages/single/:id', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const msgId = req.params.id;
    await prisma.message.deleteMany({ where: { id: msgId } });
    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Single group message delete
router.delete('/chat/groups/messages/:id', authMiddleware, permissionMiddleware('chat.use'), async (req, res) => {
  try {
    const msgId = req.params.id;
    await prisma.groupMessage.deleteMany({ where: { id: msgId } });
    res.json({ message: 'Group message deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Department Routes
router.get('/departments', authMiddleware, async (req, res) => {
  try {
    let list = await Department.find().sort({ name: 1 });
    if (list.length === 0) {
      const defaults = ['Fabrication', 'Security', 'Supervisor', 'Kitchen', 'Admin', 'Packaging', 'Driver', 'Helper'];
      const docs = defaults.map(name => ({ name }));
      await Department.insertMany(docs);
      list = await Department.find().sort({ name: 1 });
    }
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/departments', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Department name is required' });
    }
    const cleanName = name.trim();
    const existing = await Department.findOne({ name: { $regex: new RegExp(`^${cleanName}$`, 'i') } });
    if (existing) {
      return res.status(400).json({ message: 'Department already exists' });
    }
    const dept = new Department({ name: cleanName });
    await dept.save();
    res.status(201).json(dept);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/departments/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const dept = await Department.findByIdAndDelete(req.params.id);
    if (!dept) return res.status(404).json({ message: 'Department not found' });
    res.json({ message: 'Department deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// System Settings Routes
router.get('/settings/:key', authMiddleware, async (req, res) => {
  try {
    const { key } = req.params;
    let setting = await SystemSettings.findOne({ key });
    if (!setting) {
      // Return default values for known keys
      if (key === 'kiosk_hours') {
        return res.json({
          key,
          value: { startHour: 8, startMinute: 30, endHour: 20, endMinute: 30 }
        });
      }
      return res.status(404).json({ message: `Setting with key ${key} not found` });
    }
    res.json(setting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/settings/:key', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) {
      return res.status(400).json({ message: 'Value is required' });
    }
    const setting = await SystemSettings.findOneAndUpdate(
      { key },
      { $set: { value, updatedAt: new Date() } },
      { upsert: true, new: true }
    );
    res.json(setting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Public routes for Kiosk Mode (bypasses authMiddleware)
router.get('/kiosk/labours', async (req, res) => {
  try {
    const labours = await Labour.find().sort({ name: 1 });
    res.json(labours);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/kiosk/attendance/mark', async (req, res) => {
  try {
    const { labourId, status } = req.body;
    if (!labourId) {
      return res.status(400).json({ message: 'labourId is required' });
    }
    const recordStatus = status || 'present';

    // Strip time to store clean date (midnight UTC)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const record = await Attendance.findOneAndUpdate(
      { labourId, date: today },
      { $set: { status: recordStatus, permissionHours: 0, remarks: 'Marked via Face Recognition Kiosk (Public)' } },
      { upsert: true, new: true }
    );

    res.json({ message: 'Attendance marked successfully', record });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/kiosk/settings/kiosk_hours', async (req, res) => {
  try {
    const key = 'kiosk_hours';
    let setting = await SystemSettings.findOne({ key });
    if (!setting) {
      return res.json({
        key,
        value: { startHour: 8, startMinute: 30, endHour: 20, endMinute: 30 }
      });
    }
    res.json(setting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/kiosk/settings/kiosk_location', async (req, res) => {
  try {
    const key = 'kiosk_location';
    let setting = await SystemSettings.findOne({ key });
    if (!setting) {
      return res.json({
        key,
        value: { lat: 10.997544, lng: 76.878663 }
      });
    }
    res.json(setting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/kiosk/settings/kiosk_alarm', async (req, res) => {
  try {
    const key = 'kiosk_alarm';
    let setting = await SystemSettings.findOne({ key });
    if (!setting) {
      return res.json({
        key,
        value: { alarmHour: 8, alarmMinute: 30 }
      });
    }
    res.json(setting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/kiosk/attendance/status/:labourId', async (req, res) => {
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const record = await Attendance.findOne({ labourId: req.params.labourId, date: today });
    res.json({ punched: !!record, status: record ? record.status : null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
