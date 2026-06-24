const mongoose = require('mongoose');
const LabourSchema = new mongoose.Schema({ name: String, empCode: String, status: String, employeeType: String }, { strict: false });
mongoose.connect('mongodb://127.0.0.1:27017/LabourManagement').then(async () => {
  const Labour = mongoose.model('Labour', LabourSchema);
  const total = await Labour.countDocuments();
  const active = await Labour.countDocuments({ status: 'active' });
  const staff = await Labour.countDocuments({ employeeType: 'staff' });
  const labourers = await Labour.countDocuments({ employeeType: 'labourer' });
  const noType = await Labour.countDocuments({ employeeType: { $exists: false } });
  console.log('Total:', total, '| Active:', active);
  console.log('Staff:', staff, '| Labourers:', labourers, '| No employeeType:', noType);
  
  // Sample a few to see structure
  const samples = await Labour.find({}).limit(5).lean();
  samples.forEach(s => console.log(' -', s.empCode, s.name, '|', s.status, '|', s.employeeType));
  mongoose.disconnect();
});
