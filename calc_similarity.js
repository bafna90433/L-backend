const mongoose = require('mongoose');
const { Labour } = require('./models');

const mongoUri = 'mongodb+srv://Labour:Labour123@labour.ajkpera.mongodb.net/LabourManagement';

function calculateCosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function calculateL2Distance(vecA, vecB) {
  if (vecA.length !== vecB.length) return 999;
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    sum += Math.pow(vecA[i] - vecB[i], 2);
  }
  return Math.sqrt(sum);
}

async function test() {
  await mongoose.connect(mongoUri);
  const labourers = await Labour.find({ faceEmbedding: { $exists: true, $not: { $size: 0 } } });
  
  console.log(`Comparing ${labourers.length} registered labourers:`);
  for (let i = 0; i < labourers.length; i++) {
    for (let j = i + 1; j < labourers.length; j++) {
      const sim = calculateCosineSimilarity(labourers[i].faceEmbedding, labourers[j].faceEmbedding);
      const dist = calculateL2Distance(labourers[i].faceEmbedding, labourers[j].faceEmbedding);
      console.log(`${labourers[i].name} vs ${labourers[j].name}:`);
      console.log(`  Cosine Similarity: ${sim}`);
      console.log(`  L2 Distance: ${dist}`);
    }
  }
  await mongoose.disconnect();
}

test();
