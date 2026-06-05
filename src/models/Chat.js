const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    isGroup: {
      type: Boolean,
      default: false,
    },
    groupName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 100,
    },
    groupAvatarUrl: {
      type: String,
      default: '',
    },
    groupAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
    ],
    lastMessage: {
      messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
      content: { type: String, default: '' },
      type: { type: String, enum: ['text', 'image', 'audio', 'video', 'file', 'call', 'system'], default: 'text' },
      senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      timestamp: { type: Date },
    },
    unreadCounts: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        count: { type: Number, default: 0 },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Compound index for fetching user's conversations sorted by last message time
chatSchema.index({ participants: 1, updatedAt: -1 });

// Ensure max 2 participants for direct chats
chatSchema.pre('save', function (next) {
  if (!this.isGroup && this.participants.length > 2) {
    return next(new Error('Direct chat cannot have more than 2 participants'));
  }
  if (this.isGroup && this.participants.length < 2) {
    return next(new Error('Group chat must have at least 2 participants'));
  }
  next();
});

module.exports = mongoose.model('Chat', chatSchema);