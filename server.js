require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { connectDatabase } = require('./database');
const apiRoutes = require('./routes');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
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

console.log(`Connecting to ${(process.env.DATABASE_PROVIDER || 'mongodb').toLowerCase()} database...`);

connectDatabase()
  .then(({ provider }) => {
    console.log(`Connected to ${provider} successfully!`);
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database connection error:', err);
    process.exit(1);
  });
