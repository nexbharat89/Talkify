const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { createError } = require('../middleware/errorHandler');

/**
 * Helper: Find or create a 1-on-1 chat between two users.
 * Returns the chat document (Mongoose object, not lean).
 */
const findOrCreateDirectChat = async (userId1, userId2) => {
  // Ensure consistent ordering so we always find the same chat
  const [idA, idB] = [userId1, userId2].sort();

  let chat = await Chat.findOne({
    isGroup: false,
    participants: { $all: [idA, idB], $size: 2 },
  });

  if (!chat) {
    chat = await Chat.create({
      isGroup: false,
      participants: [idA, idB],
      unreadCounts: [
        { userId: idA, count: 0 },
        { userId: idB, count: 0 },
      ],
    });
  }

  return chat;
};

/**
 * POST /api/chats/direct
 * Find or create a 1-on-1 chat between the authenticated user and a peer.
 */
const getOrCreateDirectChat = async (req, res, next) => {
  try {
    const { peerId } = req.body;

    if (!peerId || typeof peerId !== 'string' || !peerId.trim()) {
      throw createError(400, 'peerId is required');
    }

    // Prevent creating a chat with yourself
    if (peerId === req.user.userId) {
      throw createError(400, 'Cannot create a chat with yourself');
    }

    // Verify peer exists
    const peer = await User.findById(peerId).select('_id').lean();
    if (!peer) {
      throw createError(404, 'User not found');
    }

    const chat = await findOrCreateDirectChat(req.user.userId, peerId);
    await chat.populate('participants', 'name phone avatarUrl bio status lastSeen');

    const otherParticipant = chat.participants.find(
      (p) => p._id.toString() !== req.user.userId
    );

    res.status(200).json({
      chatId: chat._id,
      isGroup: chat.isGroup,
      participant: otherParticipant
        ? {
            id: otherParticipant._id,
            name: otherParticipant.name,
            phone: otherParticipant.phone,
            avatarUrl: otherParticipant.avatarUrl,
            bio: otherParticipant.bio,
            status: otherParticipant.status,
            lastSeen: otherParticipant.lastSeen,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chats
 * Returns the list of conversations for the authenticated user.
 */
const getChats = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const chats = await Chat.find({
      participants: req.user.userId,
    })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10))
      .populate('participants', 'name phone avatarUrl bio status lastSeen')
      .populate('lastMessage.messageId')
      .lean();

    const total = await Chat.countDocuments({ participants: req.user.userId });

    // Transform response to match API spec
    const chatList = chats.map((chat) => {
      const otherParticipants = chat.participants.filter(
        (p) => p._id.toString() !== req.user.userId
      );

      const unreadEntry = chat.unreadCounts?.find(
        (uc) => uc.userId?.toString() === req.user.userId
      );

      return {
        chatId: chat._id,
        isGroup: chat.isGroup,
        groupName: chat.groupName || null,
        groupAvatarUrl: chat.groupAvatarUrl || null,
        participant: chat.isGroup ? null : otherParticipants[0] || null,
        participants: chat.isGroup ? chat.participants : null,
        lastMessage: chat.lastMessage?.messageId
          ? {
              id: chat.lastMessage.messageId._id,
              content: chat.lastMessage.content,
              type: chat.lastMessage.type,
              senderId: chat.lastMessage.senderId,
              timestamp: chat.lastMessage.timestamp,
            }
          : null,
        unreadCount: unreadEntry?.count || 0,
      };
    });

    res.status(200).json({
      chats: chatList,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / parseInt(limit, 10)),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chats/:chatId/messages
 * Returns paginated historical messages for a specific chat.
 */
const getMessages = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const { before, limit = 50 } = req.query;

    // Verify user is a participant of this chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.userId,
    }).lean();

    if (!chat) {
      throw createError(403, 'You are not a participant of this chat');
    }

    // Build query
    const query = { chatId, isDeleted: false };
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10))
      .populate('senderId', 'name avatarUrl phone')
      .lean();

    const total = await Message.countDocuments({ chatId, isDeleted: false });

    res.status(200).json({
      messages: messages.reverse().map((msg) => ({
        id: msg._id,
        senderId: msg.senderId._id,
        senderName: msg.senderId.name,
        senderAvatar: msg.senderId.avatarUrl,
        type: msg.type,
        content: msg.content,
        media: msg.media || null,
        replyTo: msg.replyTo || null,
        forwardedFrom: msg.forwardedFrom || null,
        reactions: (msg.reactions || []).map((r) => ({
          userId: r.userId?.toString(),
          emoji: r.emoji,
        })),
        timestamp: msg.createdAt,
        status: msg.status,
      })),
      pagination: {
        before: before || null,
        limit: parseInt(limit, 10),
        total,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/chats/group
 * Creates a new group chat.
 */
const createGroup = async (req, res, next) => {
  try {
    const { name, participants, avatarUrl } = req.body;

    if (!name || !name.trim()) {
      throw createError(400, 'Group name is required');
    }

    if (!participants || !Array.isArray(participants) || participants.length < 1) {
      throw createError(400, 'At least one participant is required');
    }

    // Ensure the creator is included
    const allParticipants = [...new Set([req.user.userId, ...participants])];

    if (allParticipants.length < 2) {
      throw createError(400, 'Group must have at least 2 participants (including you)');
    }

    if (allParticipants.length > 256) {
      throw createError(400, 'Maximum 256 participants allowed');
    }

    // Verify all participant IDs exist
    const validUsers = await User.find({
      _id: { $in: allParticipants },
      isDeleted: false,
    }).select('_id');

    if (validUsers.length !== allParticipants.length) {
      throw createError(400, 'One or more participants are invalid');
    }

    const chat = await Chat.create({
      isGroup: true,
      groupName: name.trim(),
      groupAvatarUrl: avatarUrl || '',
      groupAdmin: req.user.userId,
      participants: allParticipants,
      unreadCounts: allParticipants.map((p) => ({ userId: p, count: 0 })),
    });

    res.status(201).json({
      chatId: chat._id,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chats/search?q=...
 * Searches the authenticated user's chats: message text matches plus chat /
 * group name matches. Returns a flat list of results with a content snippet.
 */
const searchMessages = async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 1) {
      return res.status(200).json({ results: [] });
    }

    // Escape regex special chars from the user query
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(safe, 'i');

    // Only search within chats the user participates in
    const chats = await Chat.find({ participants: req.user.userId })
      .select('_id isGroup groupName groupAvatarUrl participants')
      .populate('participants', 'name avatarUrl')
      .lean();

    const chatIds = chats.map((c) => c._id);
    const chatById = new Map(chats.map((c) => [c._id.toString(), c]));

    // Matching messages (most recent first, capped)
    const messages = await Message.find({
      chatId: { $in: chatIds },
      isDeleted: false,
      type: 'text',
      content: regex,
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('senderId', 'name avatarUrl')
      .lean();

    const buildChatMeta = (chat) => {
      if (chat.isGroup) {
        return {
          name: chat.groupName || 'Group',
          avatarUrl: chat.groupAvatarUrl || '',
          isGroup: true,
        };
      }
      const other = chat.participants.find(
        (p) => p._id.toString() !== req.user.userId
      );
      return {
        name: other?.name || 'Unknown',
        avatarUrl: other?.avatarUrl || '',
        isGroup: false,
      };
    };

    const messageResults = messages.map((m) => {
      const chat = chatById.get(m.chatId.toString());
      const meta = chat ? buildChatMeta(chat) : { name: '', avatarUrl: '', isGroup: false };
      return {
        kind: 'message',
        chatId: m.chatId,
        messageId: m._id,
        snippet: m.content,
        senderName: m.senderId?.name || '',
        timestamp: m.createdAt,
        chatName: meta.name,
        chatAvatarUrl: meta.avatarUrl,
        isGroup: meta.isGroup,
      };
    });

    // Matching chats/groups by name
    const chatResults = chats
      .filter((c) => {
        const meta = buildChatMeta(c);
        return regex.test(meta.name);
      })
      .map((c) => {
        const meta = buildChatMeta(c);
        return {
          kind: 'chat',
          chatId: c._id,
          chatName: meta.name,
          chatAvatarUrl: meta.avatarUrl,
          isGroup: meta.isGroup,
        };
      });

    res.status(200).json({
      results: [...chatResults, ...messageResults],
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getOrCreateDirectChat, getChats, getMessages, createGroup, searchMessages };
