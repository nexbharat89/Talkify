const config = require('../config');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { sendOtpEmail } = require('./emailService');
const { createError } = require('../middleware/errorHandler');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Generate a random 6-digit OTP and a bcrypt hash for storage.
 * The plaintext OTP is emailed to the user; only the hash is persisted.
 */
const generateOtp = () => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = bcrypt.hashSync(otp, 10);
  return { otp, otpHash };
};

/**
 * Verify an entered OTP against the bcrypt hash stored when it was sent.
 */
const verifyOtpHash = (otp, storedOtpHash) => {
  const isValid = bcrypt.compareSync(otp, storedOtpHash || '');
  if (!isValid) throw createError(400, 'Invalid OTP');
  return true;
};

/**
 * Generate JWT access and refresh tokens.
 */
const generateTokens = (user) => {
  const payload = { userId: user._id.toString(), phone: user.phone };

  const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiry,
  });

  const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiry,
  });

  return { accessToken, refreshToken };
};

// =============================================================================
// Controller Methods
// =============================================================================

/**
 * POST /api/auth/send-otp
 * Body: { phone, email, name }
 * Generates an OTP and delivers it to the user's email via SMTP.
 */
const sendOtp = async (req, res, next) => {
  try {
    const { phone, email, name } = req.body;

    if (!phone || !/^\+\d{10,15}$/.test(phone)) {
      throw createError(400, 'Valid phone number with country code is required (e.g. +919876543210)');
    }

    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
      throw createError(400, 'A valid email address is required');
    }

    const normalizedName = (name || '').trim();
    if (!normalizedName || normalizedName.length < 2) {
      throw createError(400, 'A valid name is required');
    }

    // Find or create user placeholder (not fully registered until OTP verified)
    let user = await User.findOne({ phone, isDeleted: false });
    if (!user) {
      user = new User({ phone });
    }
    user.email = normalizedEmail;
    user.name = normalizedName;

    const { otp, otpHash } = generateOtp();
    await sendOtpEmail(normalizedEmail, otp, normalizedName);

    // Store OTP hash with expiry
    user.otpHash = otpHash;
    user.otpExpiresAt = new Date(Date.now() + config.smtp.otpExpiryMinutes * 60 * 1000);
    user.otpReferenceId = null;
    await user.save();

    res.status(200).json({
      message: 'OTP sent successfully to your email',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/verify-otp
 * Body: { phone, otp, fcmToken? }
 */
const verifyOtp = async (req, res, next) => {
  try {
    const { phone, otp, fcmToken } = req.body;

    if (!phone || !otp) {
      throw createError(400, 'Phone and OTP are required');
    }

    const user = await User.findOne({ phone, isDeleted: false });
    if (!user) {
      throw createError(404, 'User not found. Please request OTP first.');
    }

    // Check OTP expiry
    if (user.otpExpiresAt && new Date() > user.otpExpiresAt) {
      throw createError(400, 'OTP has expired. Please request a new one.');
    }

    // Verify OTP against the stored hash
    verifyOtpHash(otp, user.otpHash);

    const isNewUser = !user.name; // New user if name hasn't been set

    // Clear OTP fields
    user.otpHash = null;
    user.otpExpiresAt = null;
    user.otpReferenceId = null;

    // Store FCM token if provided
    if (fcmToken) {
      const existingTokenIndex = user.fcmTokens.findIndex((t) => t.token === fcmToken);
      if (existingTokenIndex >= 0) {
        user.fcmTokens[existingTokenIndex].updatedAt = new Date();
      } else {
        user.fcmTokens.push({ token: fcmToken, device: 'mobile', updatedAt: new Date() });
        // Keep only last 5 tokens
        if (user.fcmTokens.length > 5) {
          user.fcmTokens = user.fcmTokens.slice(-5);
        }
      }
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);
    user.refreshToken = refreshToken;
    await user.save();

    res.status(200).json({
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        phone: user.phone,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        isNewUser,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/refresh
 */
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      throw createError(400, 'Refresh token is required');
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.refreshSecret);
    } catch (err) {
      throw createError(401, 'Invalid or expired refresh token');
    }

    const user = await User.findById(decoded.userId);
    if (!user || user.isDeleted) {
      throw createError(401, 'User not found');
    }

    // Validate stored refresh token
    if (user.refreshToken !== token) {
      throw createError(401, 'Refresh token has been revoked');
    }

    // Generate new token pair
    const tokens = generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    res.status(200).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { sendOtp, verifyOtp, refreshToken };
