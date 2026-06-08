const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      default: '',
      trim: true,
      maxlength: 50,
    },
    bio: {
      type: String,
      default: 'Hey there! I am using Talkify.',
      maxlength: 150,
    },
    avatarUrl: {
      type: String,
      default: '',
    },
    // ImageKit fileId for the current avatar, so we can delete it directly
    // (ImageKit's listFiles searchQuery does NOT support a `url` field).
    avatarFileId: {
      type: String,
      default: '',
    },
    fcmTokens: [
      {
        token: { type: String, required: true },
        device: { type: String, default: 'unknown' },
        updatedAt: { type: Date, default: Date.now },
      },
    ],
    status: {
      type: String,
      enum: ['online', 'offline'],
      default: 'offline',
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    refreshToken: {
      type: String,
      default: null,
    },
    otpHash: {
      type: String,
      default: null,
    },
    otpExpiresAt: {
      type: Date,
      default: null,
    },
    otpReferenceId: {
      type: String,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        delete ret.otpHash;
        delete ret.otpExpiresAt;
        delete ret.otpReferenceId;
        delete ret.refreshToken;
        delete ret.fcmTokens;
        delete ret.isDeleted;
        return ret;
      },
    },
  }
);

// Index for contact sync queries
userSchema.index({ phone: 1, isDeleted: 1 });

module.exports = mongoose.model('User', userSchema);