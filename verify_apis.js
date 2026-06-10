const http = require('http');

const API_PORT = 5000;
const HOST = 'localhost';

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, rawBody: data });
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- Integration API Tests ---');
  let ownerToken = null;
  let staffToken = null;

  // 1. Owner Login Test
  try {
    console.log('Testing Owner login...');
    const loginRes = await makeRequest({
      hostname: HOST,
      port: API_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'owner', password: 'Owner123' });

    if (loginRes.status === 200 && loginRes.body.token) {
      console.log('Owner login passed!');
      ownerToken = loginRes.body.token;
    } else {
      console.error('Owner login failed:', loginRes);
      process.exit(1);
    }
  } catch (err) {
    console.error('Owner login request error:', err.message);
    process.exit(1);
  }

  // 2. Staff Login Test
  try {
    console.log('Testing Staff login...');
    const loginRes = await makeRequest({
      hostname: HOST,
      port: API_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'staff', password: 'Staff123' });

    if (loginRes.status === 200 && loginRes.body.token) {
      console.log('Staff login passed!');
      staffToken = loginRes.body.token;
    } else {
      console.error('Staff login failed:', loginRes);
      process.exit(1);
    }
  } catch (err) {
    console.error('Staff login request error:', err.message);
    process.exit(1);
  }

  // 3. Fetch Balance Test
  try {
    console.log('Testing Balance calculation...');
    const balRes = await makeRequest({
      hostname: HOST,
      port: API_PORT,
      path: '/api/expenses/balance',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${ownerToken}` }
    });

    if (balRes.status === 200 && balRes.body.activeBalance !== undefined) {
      console.log('Balance calculation passed!');
      console.log(`Active cash balance: ₹${balRes.body.activeBalance}`);
      console.log(`Total cash received: ₹${balRes.body.totalReceived}`);
      console.log(`Total cash spent: ₹${balRes.body.totalSpent}`);
    } else {
      console.error('Balance calculation failed:', balRes);
      process.exit(1);
    }
  } catch (err) {
    console.error('Balance request error:', err.message);
    process.exit(1);
  }

  // 4. Fetch Labour List Test
  try {
    console.log('Testing Fetch Labourers...');
    const labRes = await makeRequest({
      hostname: HOST,
      port: API_PORT,
      path: '/api/labours',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${staffToken}` }
    });

    if (labRes.status === 200 && Array.isArray(labRes.body)) {
      console.log(`Fetch Labourers passed! Seeded labourers: ${labRes.body.length}`);
      labRes.body.forEach(l => console.log(`- ${l.name} (Salary: ₹${l.monthlySalary})`));
    } else {
      console.error('Fetch Labourers failed:', labRes);
      process.exit(1);
    }
  } catch (err) {
    console.error('Labourers request error:', err.message);
    process.exit(1);
  }

  console.log('\nAll Integration tests completed successfully! API works as expected.');
  process.exit(0);
}

// Check server status before starting tests
setTimeout(() => {
  runTests();
}, 2000);
