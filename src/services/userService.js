const User = require('../models/User');
const Chat = require('../models/Chat');
const { createError } = require('../middleware/errorHandler');
const { getImageKit } = require('../config/imagekit');
const path = require('path');

/**
 * GET /api/users/profile
 */
const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId).lean();
    if (!user || user.isDeleted) {
      throw createError(404, 'User not found');
    }

    res.status(200).json({
      id: user._id,
      phone: user.phone,
      name: user.name,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      status: user.status,
      lastSeen: user.lastSeen,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/users/profile
 * Accepts: multipart/form-data
 * Fields: name (text), bio (text)
 * File:   avatar (image file)
 *
 * Accepted image types: jpg, jpeg, png, gif, webp, bmp, svg
 * Maximum file size: 5 MB
 */
const updateProfile = async (req, res, next) => {
  let uploadedImageKitFileId = null;

  try {
    const { name, bio } = req.body;
    const avatarFile = req.file; // Provided by multer middleware (memoryStorage)

    const updates = {};
    if (name !== undefined && name !== '') updates.name = name;
    if (bio !== undefined && bio !== '') updates.bio = bio;

    // --- Handle avatar image upload to ImageKit ---
    if (avatarFile) {
      // Validate MIME type (accepts any image/* — multer already pre-filters)
      if (!avatarFile.mimetype || !avatarFile.mimetype.startsWith('image/')) {
        throw createError(
          400,
          `Invalid image type: ${avatarFile.mimetype}. Please upload a valid image file.`
        );
      }

      const imagekit = getImageKit();
      if (!imagekit) {
        throw createError(503, 'Media service is not configured');
      }

      // Upload directly from memory buffer (no disk I/O)
      const ext = path.extname(avatarFile.originalname) || '.jpg';
      const uploadResponse = await imagekit.upload({
        file: avatarFile.buffer,
        fileName: `avatar_${req.user.userId}_${Date.now()}${ext}`,
        folder: '/talkify/avatars/',
        useUniqueFileName: true,
      });

      uploadedImageKitFileId = uploadResponse.fileId;
      updates.avatarUrl = uploadResponse.url;
      updates.avatarFileId = uploadResponse.fileId;

      // --- Delete old avatar from ImageKit if it exists ---
      // Delete by stored fileId (ImageKit searchQuery does not support `url`).
      const currentUser = await User.findById(req.user.userId)
        .select('avatarFileId')
        .lean();
      if (currentUser && currentUser.avatarFileId) {
        try {
          await imagekit.deleteFile(currentUser.avatarFileId);
        } catch (deleteErr) {
          // Non-critical: log and continue
          console.warn('[userService] Failed to delete old avatar:', deleteErr.message);
        }
      }
    }

    // --- Handle avatar removal (reset to default) ---
    // Sent as form field `removeAvatar=true` when no new file is uploaded.
    const removeAvatar =
      req.body.removeAvatar === 'true' || req.body.removeAvatar === true;
    if (!avatarFile && removeAvatar) {
      const currentUser = await User.findById(req.user.userId)
        .select('avatarFileId')
        .lean();
      // Best-effort delete of the ImageKit file by stored fileId. This must
      // NOT block clearing the DB — otherwise an ImageKit error would leave
      // the old avatarUrl in place and the picture would reappear on reload.
      if (currentUser && currentUser.avatarFileId) {
        const imagekit = getImageKit();
        if (imagekit) {
          try {
            await imagekit.deleteFile(currentUser.avatarFileId);
          } catch (deleteErr) {
            // Non-critical: log and continue
            console.warn(
              '[userService] Failed to delete avatar on removal:',
              deleteErr.message
            );
          }
        }
      }
      updates.avatarUrl = '';
      updates.avatarFileId = '';
    }

    if (Object.keys(updates).length === 0) {
      throw createError(400, 'No valid fields to update');
    }

    const user = await User.findByIdAndUpdate(req.user.userId, updates, {
      new: true,
      runValidators: true,
    }).lean();

    if (!user) {
      throw createError(404, 'User not found');
    }

    res.status(200).json({
      message: 'Profile updated',
      user: {
        id: user._id,
        phone: user.phone,
        name: user.name,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
      },
    });
  } catch (err) {
    // If we uploaded to ImageKit but DB update failed, delete the uploaded image
    if (uploadedImageKitFileId) {
      try {
        const imagekit = getImageKit();
        if (imagekit) {
          await imagekit.deleteFile(uploadedImageKitFileId);
        }
      } catch (_) {
        // ignore
      }
    }
    next(err);
  }
};

/**
 * POST /api/users/sync-contacts
 * Accepts an array of phone contacts, returns registered and unregistered splits.
 */
/**
 * Normalize a phone number to E.164 format.
 * Mirrors the Flutter _normalizePhone logic exactly so that
 * numbers from device contacts always match DB-stored numbers.
 *
 * Examples:
 *   '8076574242'       → '+918076574242'
 *   '08076574242'      → '+918076574242'
 *   '+91 8076574242'   → '+918076574242'
 *   '918076574242'     → '+918076574242'
 *   '+918076574242'    → '+918076574242'
 */
const normalizePhone = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  // Strip ALL non-digit characters (spaces, dashes, parens, plus sign)
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  // Remove leading 0 if present (common in Indian contacts: 08076574242)
  if (digits.length > 10 && digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  // 10 digits = Indian local number → add +91
  if (digits.length === 10) return `+91${digits}`;
  // 12 digits starting with 91 = Indian with country code → add +
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  // Any other length > 10 → just add +
  if (digits.length > 10) return `+${digits}`;
  // Fallback (short numbers, etc.)
  return `+${digits}`;
};

const syncContacts = async (req, res, next) => {
  try {
    const { contacts } = req.body;

    if (!Array.isArray(contacts)) {
      throw createError(400, 'contacts must be an array');
    }

    if (contacts.length === 0) {
      return res.status(200).json({ registeredUsers: [], unregisteredContacts: [] });
    }

    if (contacts.length > 1000) {
      throw createError(400, 'Maximum 1000 contacts per request');
    }

    // Normalize all incoming phone numbers using E.164 normalization
    // (same logic as Flutter's _normalizePhone)
    const normalizedContacts = contacts.map((c) => ({
      ...c,
      phone: normalizePhone(c.phone),
    }));

    const phones = normalizedContacts.map((c) => c.phone).filter(Boolean);
    console.log(`[syncContacts] Received ${phones.length} phones. Sample: ${phones.slice(0, 5).join(', ')}`);

    // Get the current user's phone to exclude from results
    const currentUserPhone = req.user.phone;
    console.log(`[syncContacts] Current user phone: ${currentUserPhone}`);

    // Find all registered users matching those phones
    const registeredUsers = await User.find({
      phone: { $in: phones },
      isDeleted: false,
    })
      .select('phone name avatarUrl')
      .lean();

    console.log(`[syncContacts] DB match: ${registeredUsers.length} registered users found.`);
    if (registeredUsers.length > 0) {
      console.log(`[syncContacts] Sample: ${registeredUsers.slice(0, 3).map(u => u.phone).join(', ')}`);
    }

    // DEBUG: show all registered phones in DB (first 10)
    const sampleDB = await User.find({ isDeleted: false }).select('phone').limit(10).lean();
    console.log(`[syncContacts] DB sample users: ${sampleDB.map(u => u.phone).join(', ')}`);

    // Build a map from phone → talkify user for O(1) lookup
    const registeredPhoneMap = new Map();
    for (const u of registeredUsers) {
      registeredPhoneMap.set(u.phone, u);
    }

    // Map registered users with their local contact name,
    // excluding the current user's own phone number.
    //
    // Also fetch existing direct chats so the Flutter app knows which
    // chatId to open without needing a separate API call.
    const registeredResult = [];
    const unregisteredResult = [];

    const registeredUserIds = [];
    for (const c of normalizedContacts) {
      if (!c.phone) continue;
      const talkifyUser = registeredPhoneMap.get(c.phone);
      if (talkifyUser && c.phone !== currentUserPhone) {
        registeredUserIds.push(talkifyUser._id);
      }
    }

    // Fetch ALL direct (1-on-1) chats the current user participates in.
    // We filter in-memory since per-user direct chat counts are typically low.
    const existingChats = await Chat.find({
      isGroup: false,
      participants: req.user.userId,
    }).lean();

    // Build a map: contactUserId -> chatId
    const chatIdMap = new Map();
    for (const chat of existingChats) {
      // Only consider 2-person chats (safety check)
      if (chat.participants.length !== 2) continue;
      for (const pId of chat.participants) {
        const pidStr = pId.toString();
        if (pidStr !== req.user.userId) {
          chatIdMap.set(pidStr, chat._id.toString());
        }
      }
    }

    for (const c of normalizedContacts) {
      if (!c.phone) continue;

      const talkifyUser = registeredPhoneMap.get(c.phone);

      if (talkifyUser) {
        // Skip the current user (don't show yourself in the contact list)
        if (c.phone === currentUserPhone) continue;

        const uid = talkifyUser._id.toString();
        registeredResult.push({
          phone: c.phone,
          id: talkifyUser._id,
          chatId: chatIdMap.get(uid) || '',
          talkifyName: talkifyUser.name || '',
          localName: c.name || '',
          avatarUrl: talkifyUser.avatarUrl || '',
        });
      } else {
        unregisteredResult.push({
          phone: c.phone,
          localName: c.name || '',
        });
      }
    }

    console.log(`[syncContacts] Result: ${registeredResult.length} registered (excl. self), ${unregisteredResult.length} unregistered`);

    res.status(200).json({
      registeredUsers: registeredResult,
      unregisteredContacts: unregisteredResult,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getProfile, updateProfile, syncContacts };