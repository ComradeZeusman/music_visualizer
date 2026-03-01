import express from 'express';
import indexRoute, { handleMulterError } from './indexroute/index.js';

const router = express.Router();

router.use('/', indexRoute);

// Add error handling middleware
router.use(handleMulterError);

export default router;
