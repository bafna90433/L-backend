const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const ImageKit = require('imagekit');
const { User, Labour, Attendance, CashTx, AdvanceRequest, Reminder, Task, Message, Department, SystemSettings } = require('./models');

const JWT_SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

// Initialize ImageKit
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || 'public_LB0AyCgim15VO491kDtVm0Fo798=',
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || 'private_nRKX1cLNUCab5WJX4cWNCnWqk3U=',
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/rishii'
});

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
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        whatsapp: user.whatsapp || '',
        imageUrl: user.imageUrl || ''
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.get('/auth/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user });
});

router.put('/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { name, whatsapp, imageUrl } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name !== undefined) user.name = name;
    if (whatsapp !== undefined) user.whatsapp = whatsapp;
    if (imageUrl !== undefined) user.imageUrl = imageUrl;

    await user.save();
    res.json({ 
      message: 'Profile updated successfully', 
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        whatsapp: user.whatsapp,
        imageUrl: user.imageUrl
      } 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/staff', authMiddleware, async (req, res) => {
  try {
    const staffList = await User.find({ role: { $in: ['staff', 'staff2'] } }).select('name username _id role whatsapp imageUrl');
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
    if (staffUser.role !== 'staff' && staffUser.role !== 'staff2') {
      return res.status(400).json({ message: 'Only staff names can be updated' });
    }
    staffUser.name = name;
    await staffUser.save();
    res.json({ message: 'Staff name updated successfully', user: staffUser });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/owner', authMiddleware, async (req, res) => {
  try {
    const owner = await User.findOne({ role: 'owner' }).select('name username _id whatsapp imageUrl');
    if (!owner) return res.status(404).json({ message: 'Owner not found' });
    res.json(owner);
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
router.get('/labours', authMiddleware, async (req, res) => {
  try {
    const labours = await Labour.find().sort({ name: 1 });
    res.json(labours);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/labours', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { name, whatsapp, monthlySalary, imageUrl, employeeType, department, phonePeNumber, upiId, phonePeQrUrl, empCode } = req.body;
    if (!name || !whatsapp || monthlySalary === undefined) {
      return res.status(400).json({ message: 'Name, WhatsApp, and Monthly Salary are required' });
    }
    const labour = new Labour({ name, whatsapp, monthlySalary, imageUrl, employeeType, department, phonePeNumber, upiId, phonePeQrUrl, empCode });
    await labour.save();
    res.status(201).json(labour);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/labours/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { name, whatsapp, monthlySalary, imageUrl, status, employeeType, department, phonePeNumber, upiId, phonePeQrUrl, empCode } = req.body;
    const labour = await Labour.findById(req.params.id);
    if (!labour) return res.status(404).json({ message: 'Labourer not found' });
    
    if (name) labour.name = name;
    if (whatsapp) labour.whatsapp = whatsapp;
    if (monthlySalary !== undefined) labour.monthlySalary = monthlySalary;
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

router.delete('/labours/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const labour = await Labour.findByIdAndDelete(req.params.id);
    if (!labour) return res.status(404).json({ message: 'Labourer not found' });
    res.json({ message: 'Labourer deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Attendance Routes
router.get('/attendance', authMiddleware, async (req, res) => {
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
      parsedDate.setUTCHours(0,0,0,0);
      
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
router.put('/labours/:id/face', authMiddleware, async (req, res) => {
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
router.post('/attendance/mark', authMiddleware, async (req, res) => {
  try {
    const { labourId, status } = req.body;
    if (!labourId) {
      return res.status(400).json({ message: 'labourId is required' });
    }
    const recordStatus = status || 'present';
    
    // Strip time to store clean date (midnight UTC)
    const today = new Date();
    today.setUTCHours(0,0,0,0);

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
      let awayMs = 0;

      for (let i = 0; i < currentPunches.length; i++) {
        if (i % 2 === 1) {
          activeMs += new Date(currentPunches[i]) - new Date(currentPunches[i - 1]);
        } else if (i > 0) {
          awayMs += new Date(currentPunches[i]) - new Date(currentPunches[i - 1]);
        }
      }

      const activeHours = activeMs / (1000 * 60 * 60);
      const awayHours = awayMs / (1000 * 60 * 60);

      // Check permission approval status
      const isPermissionApproved = existingRecord ? existingRecord.isPermissionApproved : false;

      // Rule: Expected Standard Shift = 8 hours
      // If approved, permissionHours = awayHours. Required shift is 8 - permissionHours.
      // If actual activeHours >= required, they are present.
      const permissionHours = isPermissionApproved ? awayHours : 0;
      const effectiveHours = activeHours + permissionHours;

      // Determine Status
      let status = 'present';
      if (effectiveHours < 4) {
        status = 'absent';
      } else if (effectiveHours < 7) {
        status = 'half-day';
      }

      // Determine Overtime
      const overtimeHours = effectiveHours > 8 ? effectiveHours - 8 : 0;

      // Generate Remarks
      let remarks = `Marked via ZKTeco Machine (${terminal_sn || 'Biometric'})`;
      if (isPermissionApproved && awayHours > 0) {
        remarks = `Present (Approved ${awayHours.toFixed(1)}h Permission)`;
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
router.post('/attendance/:id/permission', authMiddleware, async (req, res) => {
  try {
    const { isApproved } = req.body;
    if (isApproved === undefined) {
      return res.status(400).json({ message: 'isApproved is required' });
    }

    const record = await Attendance.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    record.isPermissionApproved = isApproved;
    
    // Recalculate status and effective hours based on new permission approval status
    const permissionHours = isApproved ? record.awayHours : 0;
    record.permissionHours = permissionHours;

    const effectiveHours = record.activeHours + permissionHours;

    let status = 'present';
    if (effectiveHours < 4) {
      status = 'absent';
    } else if (effectiveHours < 7) {
      status = 'half-day';
    }
    record.status = status;

    // Recalculate Overtime
    record.overtimeHours = effectiveHours > 8 ? effectiveHours - 8 : 0;

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
router.get('/expenses', authMiddleware, async (req, res) => {
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

router.get('/expenses/balance', authMiddleware, async (req, res) => {
  try {
    const txs = await CashTx.find();
    
    let totalReceived = 0;
    let totalSpent = 0;
    const categoryTotals = {
      'staff-welfare': 0,
      'petrol': 0,
      'porter-vehicle': 0,
      'sir-expenses': 0,
      'salary-advance': 0,
      'miscellaneous': 0
    };

    txs.forEach(tx => {
      if (tx.txType === 'received') {
        totalReceived += tx.amount;
      } else {
        totalSpent += tx.amount;
        if (categoryTotals[tx.category] !== undefined) {
          categoryTotals[tx.category] += tx.amount;
        }
      }
    });

    const activeBalance = totalReceived - totalSpent;
    res.json({
      totalReceived,
      totalSpent,
      activeBalance,
      categoryTotals
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Owner gives cash to office staff (received transaction)
router.post('/expenses/cash-received', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { amount, date, description, staffId } = req.body;
    if (!amount || !date || !staffId) {
      return res.status(400).json({ message: 'Amount, date, and staffId are required' });
    }

    // Verify staffId exists and is staff
    const staffUser = await User.findById(staffId);
    if (!staffUser || staffUser.role !== 'staff') {
      return res.status(400).json({ message: 'Valid staff member must be selected to receive the cash' });
    }

    const tx = new CashTx({
      txType: 'received',
      category: 'received',
      amount,
      date: new Date(date),
      description: description || `Cash received from owner`,
      staffId
    });

    await tx.save();
    res.status(201).json(tx);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Staff (or Owner) logs an expense
router.post('/expenses/log', authMiddleware, async (req, res) => {
  try {
    const { amount, date, category, description, labourId } = req.body;
    if (!amount || !date || !category) {
      return res.status(400).json({ message: 'Amount, date, and category are required' });
    }
    
    if (category === 'received') {
      return res.status(400).json({ message: 'Invalid category for expense' });
    }

    const tx = new CashTx({
      txType: 'expense',
      category,
      amount,
      date: new Date(date),
      description: description || '',
      staffId: req.user._id,
      labourId: labourId || null
    });

    await tx.save();
    res.status(201).json(tx);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Advance Requests Routes
router.post('/advances/request', authMiddleware, async (req, res) => {
  try {
    const { labourId, amount, date, reason } = req.body;
    if (!labourId || !amount || !date) {
      return res.status(400).json({ message: 'Labourer ID, amount, and date are required' });
    }

    // Verify labourer exists
    const labour = await Labour.findById(labourId);
    if (!labour) return res.status(404).json({ message: 'Labourer not found' });

    const request = new AdvanceRequest({
      labourId,
      amount,
      date: new Date(date),
      reason: reason || '',
      status: 'pending',
      requestedBy: req.user._id
    });

    await request.save();
    res.status(201).json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/advances', authMiddleware, async (req, res) => {
  try {
    const { status, labourId } = req.query;
    let query = {};
    if (status) query.status = status;
    if (labourId) query.labourId = labourId;

    // Staff can see all, Owner can see all
    const requests = await AdvanceRequest.find(query)
      .populate('labourId', 'name whatsapp monthlySalary imageUrl')
      .populate('requestedBy', 'name username')
      .populate('approvedBy', 'name username')
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

    // Populate labourer details to write transaction description
    const labour = await Labour.findById(request.labourId);

    // Create the CashTx expense
    const tx = new CashTx({
      txType: 'expense',
      category: 'salary-advance',
      amount: request.amount,
      date: request.date,
      description: `Advance paid to ${labour ? labour.name : 'Labourer'} (Approved by Owner). Reason: ${request.reason}`,
      staffId: request.requestedBy // Logged under the staff who requested it
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
router.get('/reminders', authMiddleware, async (req, res) => {
  try {
    const reminders = await Reminder.find()
      .populate('createdBy', 'name username')
      .populate('acknowledgedBy', 'name username')
      .sort({ createdAt: -1 });
    res.json(reminders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/reminders', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { message, targetDate } = req.body;
    if (!message || !targetDate) {
      return res.status(400).json({ message: 'Message and Target Date are required' });
    }

    const reminder = new Reminder({
      message,
      targetDate: new Date(targetDate),
      createdBy: req.user._id
    });

    await reminder.save();
    res.status(201).json(reminder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/reminders/:id/acknowledge', authMiddleware, async (req, res) => {
  try {
    const reminder = await Reminder.findById(req.params.id);
    if (!reminder) return res.status(404).json({ message: 'Reminder not found' });
    if (reminder.status === 'acknowledged') {
      return res.status(400).json({ message: 'Reminder already acknowledged' });
    }

    reminder.status = 'acknowledged';
    reminder.acknowledgedBy = req.user._id;
    reminder.acknowledgedAt = new Date();
    await reminder.save();

    res.json({ message: 'Reminder acknowledged successfully', reminder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Helper for task auto-reset
function checkAndResetTask(task) {
  if (task.status !== 'completed' || !task.completedAt) return false;
  const now = new Date();
  const comp = new Date(task.completedAt);
  
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
        start.setHours(0,0,0,0);
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
router.get('/tasks', authMiddleware, async (req, res) => {
  try {
    const tasks = await Task.find()
      .populate('assignedTo', 'name username')
      .populate('completedBy', 'name username')
      .sort({ taskType: 1, createdAt: 1 });
    
    let updated = false;
    for (let task of tasks) {
      if (checkAndResetTask(task)) {
        await task.save();
        updated = true;
      }
    }
    
    if (updated) {
      const refreshedTasks = await Task.find()
        .populate('assignedTo', 'name username')
        .populate('completedBy', 'name username')
        .sort({ taskType: 1, createdAt: 1 });
      return res.json(refreshedTasks);
    }
    
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/tasks', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { title, taskType, frequency, assignedTo, description, remarks, nextFollowup } = req.body;
    if (!title) {
      return res.status(400).json({ message: 'Task title is required' });
    }
    const task = new Task({
      title,
      taskType: taskType || 'custom',
      frequency: frequency || 'one-time',
      assignedTo: assignedTo || null,
      description: description || '',
      remarks: remarks || '',
      nextFollowup: nextFollowup || ''
    });
    await task.save();
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/tasks/:id/complete', authMiddleware, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    
    task.status = 'completed';
    task.completedBy = req.user._id;
    task.completedAt = new Date();
    await task.save();
    
    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name username')
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
      .populate('completedBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/tasks/:id/comment', authMiddleware, async (req, res) => {
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
      .populate('completedBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/tasks/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const { title, taskType, frequency, assignedTo, description, remarks, nextFollowup } = req.body;
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    
    if (title !== undefined) task.title = title;
    if (taskType !== undefined) task.taskType = taskType;
    if (frequency !== undefined) task.frequency = frequency;
    if (assignedTo !== undefined) task.assignedTo = assignedTo || null;
    if (description !== undefined) task.description = description;
    if (remarks !== undefined) task.remarks = remarks;
    if (nextFollowup !== undefined) task.nextFollowup = nextFollowup;

    await task.save();
    
    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name username')
      .populate('completedBy', 'name username');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/tasks/:id', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Message / Chat Routes
router.get('/messages/unread/count', authMiddleware, async (req, res) => {
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

router.get('/messages/:userId', authMiddleware, async (req, res) => {
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

router.post('/messages', authMiddleware, async (req, res) => {
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
    today.setUTCHours(0,0,0,0);

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

module.exports = router;

