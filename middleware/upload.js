// middleware/upload.js
const multer = require('multer');
const { uploadBuffer } = require('../utils/cloudinary');

// Store files in memory (buffer) so we can upload to Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'audio/webm', 'audio/mpeg'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error(`File type not allowed: ${file.mimetype}`), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
});

/**
 * Upload req.files to Cloudinary and attach results to req.uploadedFiles
 * Usage: router.post('/upload', upload.array('files', 10), handleCloudinaryUpload, handler)
 */
async function handleCloudinaryUpload(req, res, next) {
  if (!req.files || req.files.length === 0) {
    req.uploadedFiles = [];
    return next();
  }
  try {
    const results = await Promise.all(
      req.files.map((file) => {
        const isVideo = file.mimetype.startsWith('video');
        const isAudio = file.mimetype.startsWith('audio');
        return uploadBuffer(file.buffer, {
          resource_type: isVideo ? 'video' : isAudio ? 'video' : 'image',
          folder: isVideo ? 'xelosani/videos' : isAudio ? 'xelosani/audio' : 'xelosani/images',
        });
      })
    );
    req.uploadedFiles = results.map((r, i) => ({
      url: r.secure_url,
      publicId: r.public_id,
      type: req.files[i].mimetype.startsWith('video') ? 'video'
          : req.files[i].mimetype.startsWith('audio') ? 'voice'
          : 'image',
    }));
    next();
  } catch (err) {
    console.error('[UPLOAD] Cloudinary error:', err.message);
    res.status(500).json({ error: 'File upload failed' });
  }
}

module.exports = { upload, handleCloudinaryUpload };
