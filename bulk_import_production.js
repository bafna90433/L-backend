// bulk_import_production.js
// Imports all employees from Excel to the PRODUCTION Railway backend via API
const https = require('https');
const XLSX = require('xlsx');
const path = require('path');

const HOST = 'l-backend-production-ff32.up.railway.app';
const BASE_PATH = '/api';

function apiRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
    };
    const req = https.request({ hostname: HOST, path: BASE_PATH + path, method, headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // 1. Login
  console.log('🔐 Logging into production backend...');
  const loginRes = await apiRequest('POST', '/auth/login', { username: 'owner', password: 'Owner123' });
  if (!loginRes.body.token) {
    console.log('❌ Login failed:', loginRes.body);
    return;
  }
  const token = loginRes.body.token;
  console.log('✅ Logged in!\n');

  // 2. Get existing labourers
  console.log('📥 Fetching existing employees from production...');
  const existRes = await apiRequest('GET', '/labours', null, token);
  const existing = existRes.body;
  if (!Array.isArray(existing)) {
    console.log('❌ Could not fetch existing:', existing);
    return;
  }
  const existingCodes = new Set(existing.map(e => String(e.empCode || '').trim().toLowerCase()));
  const existingNames = new Set(existing.map(e => (e.name || '').trim().toLowerCase()));
  console.log(`Found ${existing.length} existing employees on production\n`);

  // 3. Read Excel
  const xlsxPath = path.join(__dirname, '..', 'ALL EMPLOYEES NAME LIST (2).xlsx');
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  const employees = [];
  for (let i = 6; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0] || !row[1]) continue;
    employees.push({ empCode: String(row[0]).trim(), name: String(row[1]).trim() });
  }
  console.log(`📋 ${employees.length} employees in Excel\n`);

  // 4. Add missing ones
  let added = 0, skipped = 0, failed = 0;

  const femaleKeywords = ['kumari','devi','bai','wati','banu','rani','priya','nithya','rekha','valli','poonkodi','ramani','mamata','shanthi','sathoshini','binodini','riddhi','ramya','sneka','sangeetha','vadivalagi','palaniammal','savitha','uma','vimala','kalaivani','veni','danalakshmi','esther','nithyasree','priyanga','rema','sindhuja','chithra','vennila','manjula','radhika','bhabani','sathiya','padmabati','maheshtwari','lalitha','rani'];

  for (const emp of employees) {
    const codeLower = emp.empCode.toLowerCase();
    const nameLower = emp.name.toLowerCase();

    if (existingCodes.has(codeLower) || existingNames.has(nameLower)) {
      console.log(`  ⏭️  SKIP: [${emp.empCode}] ${emp.name}`);
      skipped++;
      continue;
    }

    const isStaff = emp.empCode.startsWith('B');
    const isLikelyFemale = femaleKeywords.some(k => nameLower.includes(k));

    const payload = {
      name: emp.name,
      empCode: emp.empCode,
      whatsapp: '0000000000',
      monthlySalary: 0,
      shiftStart: '08:30',
      shiftEnd: '20:30',
      gender: isLikelyFemale ? 'Female' : 'Male',
      imageUrl: '',
      employeeType: isStaff ? 'staff' : 'labourer',
      department: '',
      status: 'active'
    };

    await sleep(200); // avoid rate limiting
    const res = await apiRequest('POST', '/labours', payload, token);
    if (res.status === 201 || res.status === 200) {
      console.log(`  ✅ ADDED: [${emp.empCode}] ${emp.name} (${isStaff ? 'Staff' : 'Labourer'}, ${isLikelyFemale ? 'F' : 'M'})`);
      added++;
    } else {
      console.log(`  ❌ FAIL [${emp.empCode}] ${emp.name}: status=${res.status}`, JSON.stringify(res.body).substring(0,100));
      failed++;
    }
  }

  console.log(`\n=================================`);
  console.log(`✅ Added:   ${added}`);
  console.log(`⏭️  Skipped: ${skipped} (already exist)`);
  console.log(`❌ Failed:  ${failed}`);
  console.log(`=================================`);
}

main().catch(e => console.error('FATAL:', e));
