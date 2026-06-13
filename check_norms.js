const mongoose = require('mongoose');
const { Labour } = require('./models');

const mongoUri = 'mongodb+srv://Labour:Labour123@labour.ajkpera.mongodb.net/LabourManagement';

async function run() {
  try {
    await mongoose.connect(mongoUri);
    const labourers = await Labour.find({ faceEmbedding: { $exists: true, $not: { $size: 0 } } });
    for (const l of labourers) {
      let sumSq = 0;
      for (const v of l.faceEmbedding) {
        sumSq += v * v;
      }
      console.log(`${l.name} norm: ${Math.sqrt(sumSq)}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
