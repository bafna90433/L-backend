require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS
app.use(cors({
  origin: '*', // For development allow all
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parse JSON and URL-encoded bodies
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API Routes
app.use('/api', apiRoutes);

// Simple status endpoint
app.get('/ping', (req, res) => {
  res.json({ message: 'pong', timestamp: new Date() });
});

// Serve frontend if in production
if (process.env.NODE_ENV === 'production') {
  // We can serve static files here if needed
}

// Connect to MongoDB
const mongoUri = process.env.MONGO_URI || 'mongodb+srv://Labour:Labour123@labour.ajkpera.mongodb.net/LabourManagement?retryWrites=true&w=majority';
console.log('Connecting to MongoDB...');

mongoose.connect(mongoUri)
  .then(() => {
    console.log('Connected to MongoDB successfully!');
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
