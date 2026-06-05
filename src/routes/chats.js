const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const authenticate = require('../middleware/auth');
const { getOrCreateDirectChat, getChats, getMessages, createGroup, searchMessages, updateGroupAvatar } = require('../services/messagingService');

const router = Router();

// Allowed image extensions (lowercase, no dot)
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg',
]);

// --- Multer config for group avatar upload (in-memory, no disk storage) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    if (file.mimetype === 'application/octet-stream' && file.originalname) {
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
        return cb(null, true);
      }
    }
    cb(new Error('Invalid image type. Allowed: jpeg, png, gif, webp, bmp, svg'), false);
  },
});

// All chat routes require authentication
router.use(authenticate);

router.get('/', getChats);
router.get('/search', searchMessages);
router.get('/:chatId/messages', getMessages);
router.post('/direct', getOrCreateDirectChat);
router.post('/group', createGroup);
router.put('/:chatId/group-avatar', upload.single('avatar'), updateGroupAvatar);

module.exports = router;
