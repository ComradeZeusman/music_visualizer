import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Store active processing jobs with progress
const activeJobs = new Map();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept all files - we'll extract audio from any file that contains it
    console.log(`📁 File uploaded: "${file.originalname}", MIME type: "${file.mimetype}"`);
    cb(null, true);
  }
});

router.get('/', (req, res) => {
  res.render('index');
});

router.get('/convert', (req, res) => {
  res.render('convert');
});

router.post('/generate', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const inputPath = req.file.path;
  const outputFilename = `viz-${Date.now()}.mp4`;
  const outputPath = path.join('outputs', outputFilename);
  const jobId = `job-${Date.now()}`;
  
  // Beautiful centered waveform with dynamic rainbow colors
  // Creates vertical bars that mirror up/down from center with color cycling
  const ffmpegArgs = [
    '-i', inputPath,
    '-filter_complex',
    '[0:a]showfreqs=s=1920x1080:mode=bar:ascale=log:fscale=log:win_size=4096:colors=0x0000FF|0x00FFFF|0xFFFFFF|0xFFFF00|0xFF0000,hue=h=n*2:s=1,eq=brightness=0.1:contrast=1.2,format=yuv420p[v]',
    '-map', '[v]',
    '-map', '0:a',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '320k',
    '-y',
    outputPath
  ];

  console.log('🚀 Starting visualization generation...');
  console.log('📝 Job ID:', jobId);
  
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  let duration = 0;
  let currentTime = 0;
  
  // Initialize job tracking
  activeJobs.set(jobId, {
    progress: 0,
    status: 'processing',
    outputPath: outputPath,
    outputFilename: outputFilename
  });

  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();
    
    // Parse duration
    const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}.\d{2})/);
    if (durationMatch) {
      const hours = parseInt(durationMatch[1]);
      const minutes = parseInt(durationMatch[2]);
      const seconds = parseFloat(durationMatch[3]);
      duration = hours * 3600 + minutes * 60 + seconds;
    }
    
    // Parse current time
    const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2}.\d{2})/);
    if (timeMatch && duration > 0) {
      const hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const seconds = parseFloat(timeMatch[3]);
      currentTime = hours * 3600 + minutes * 60 + seconds;
      
      const progress = Math.min(Math.round((currentTime / duration) * 100), 99);
      activeJobs.set(jobId, {
        ...activeJobs.get(jobId),
        progress: progress,
        currentTime: currentTime,
        duration: duration
      });
      
      console.log(`⏱️  Progress: ${progress}% (${currentTime.toFixed(1)}s / ${duration.toFixed(1)}s)`);
    }
  });

  ffmpeg.on('close', (code) => {
    // Clean up uploaded file
    fs.unlink(inputPath, (unlinkErr) => {
      if (unlinkErr) console.error('Error deleting upload:', unlinkErr);
    });

    if (code !== 0) {
      console.error('❌ FFmpeg exited with code:', code);
      activeJobs.set(jobId, {
        ...activeJobs.get(jobId),
        status: 'error',
        error: 'FFmpeg processing failed'
      });
      
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log('🗑️ Cleaned up partial output file');
      }
      
      return;
    }

    console.log('✅ Visualization generated successfully!');
    console.log('📹 Output file:', outputPath);
    
    activeJobs.set(jobId, {
      ...activeJobs.get(jobId),
      progress: 100,
      status: 'completed'
    });
    
    // Clean up job after 5 minutes
    setTimeout(() => activeJobs.delete(jobId), 300000);
  });

  ffmpeg.on('error', (error) => {
    console.error('❌ FFmpeg error:', error);
    activeJobs.set(jobId, {
      ...activeJobs.get(jobId),
      status: 'error',
      error: error.message
    });
    
    fs.unlink(inputPath, () => {});
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  });
  
  // Return job ID immediately for progress tracking
  res.json({
    jobId: jobId,
    message: 'Processing started'
  });
});

// Progress endpoint
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);
  
  if (!job) {
    return res.json({ 
      status: 'unknown',
      progress: 0
    });
  }
  
  res.json(job);
});

router.post('/convert', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { format } = req.body;
  const validFormats = ['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a', 'wma', 'opus'];
  
  if (!format || !validFormats.includes(format.toLowerCase())) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ 
      error: 'Invalid format',
      message: `Please specify a valid format: ${validFormats.join(', ')}`
    });
  }

  const inputPath = req.file.path;
  const outputFilename = `converted-${Date.now()}.${format}`;
  const outputPath = path.join('outputs', outputFilename);
  
  // FFmpeg conversion settings for highest quality audio (no loss)
  let codecSettings = '';
  switch (format.toLowerCase()) {
    case 'mp3':
      // Highest quality MP3: 320kbps CBR
      codecSettings = '-c:a libmp3lame -b:a 320k';
      break;
    case 'wav':
      // Lossless: 24-bit PCM for highest quality
      codecSettings = '-c:a pcm_s24le -ar 48000';
      break;
    case 'ogg':
      // Highest quality OGG Vorbis (q10 = maximum quality)
      codecSettings = '-c:a libvorbis -q:a 10';
      break;
    case 'aac':
      // Highest quality AAC: 320kbps
      codecSettings = '-c:a aac -b:a 320k -ar 48000';
      break;
    case 'flac':
      // Lossless FLAC with maximum compression
      codecSettings = '-c:a flac -compression_level 12 -ar 48000';
      break;
    case 'm4a':
      // Highest quality M4A (AAC): 320kbps
      codecSettings = '-c:a aac -b:a 320k -ar 48000';
      break;
    case 'wma':
      // Highest quality WMA
      codecSettings = '-c:a wmav2 -b:a 320k';
      break;
    case 'opus':
      // Highest quality OPUS: 256kbps (max for music)
      codecSettings = '-c:a libopus -b:a 256k -vbr on -compression_level 10';
      break;
  }

  const ffmpegCommand = `ffmpeg -i "${inputPath}" ${codecSettings} "${outputPath}" -y`;

  console.log('🚀 Starting audio conversion to', format.toUpperCase());
  
  const execOptions = {
    maxBuffer: 1024 * 1024 * 50, // 50MB buffer
    timeout: 300000 // 5 minutes timeout
  };
  
  exec(ffmpegCommand, execOptions, (error, stdout, stderr) => {
    // Clean up uploaded file
    fs.unlink(inputPath, (unlinkErr) => {
      if (unlinkErr) console.error('Error deleting upload:', unlinkErr);
    });

    if (error) {
      console.error('❌ FFmpeg conversion error:', error.message);
      console.error('📋 FFmpeg output:', stderr.substring(stderr.length - 500));
      
      // Clean up partial output
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      
      return res.status(500).json({ 
        error: 'Failed to convert audio',
        message: error.code === 'ETIMEDOUT' ? 'Conversion timeout - file may be too large' : 'FFmpeg conversion failed',
        details: stderr.substring(stderr.length - 200)
      });
    }

    console.log('✅ Audio converted successfully to', format.toUpperCase());
    console.log('📁 Output file:', outputPath);
    
    res.json({ 
      success: true, 
      downloadUrl: `/outputs/${outputFilename}`,
      format: format,
      filename: outputFilename,
      message: `Audio converted to ${format.toUpperCase()} successfully`
    });
  });
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('❌ Multer Error:', err.message);
    return res.status(400).json({ 
      error: 'File upload error',
      message: err.message,
      details: err.code
    });
  } else if (err) {
    console.error('❌ Upload Error:', err.message);
    return res.status(400).json({ 
      error: 'Invalid file',
      message: err.message
    });
  }
  next();
};

export default router;
export { handleMulterError };
