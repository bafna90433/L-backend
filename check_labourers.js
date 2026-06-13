const mongoose = require('mongoose');
const { Labour } = require('./models');

const mongoUri = 'mongodb+srv://Labour:Labour123@labour.ajkpera.mongodb.net/LabourManagement';

async function check() {
  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to Atlas DB');
    const labourers = await Labour.find({}, 'name faceEmbedding imageUrl');
    console.log(`Found ${labourers.length} labourers:`);
    for (const l of labourers) {
      console.log(`- Name: ${l.name}`);
      console.log(`  Has Embedding: ${l.faceEmbedding && l.faceEmbedding.length > 0}`);
      console.log(`  Embedding Length: ${l.faceEmbedding ? l.faceEmbedding.length : 0}`);
      if (l.faceEmbedding && l.faceEmbedding.length > 0) {
        // Print first 5 dimensions of embedding
        console.log(`  First 5 values: [${l.faceEmbedding.slice(0, 5).join(', ')}]`);
      }
      console.log(`  Image URL: ${l.imageUrl}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

check();
