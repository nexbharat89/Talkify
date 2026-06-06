const CallLog = require('../models/CallLog');
const Chat = require('../models/Chat');
const { createError } = require('../middleware/errorHandler');

/**
 * GET /api/calls/history
 * Returns paginated call history for the authenticated user. Includes both
 * 1-on-1 calls (where the user is caller or callee) and group calls for any
 * group the user belongs to — even ones they didn't attend (shown as missed).
 */
const getCallHistory = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const userId = req.user.userId;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    // Group chats this user is a member of — they should see every group call
    // placed in those chats, attended or not.
    const groupChats = await Chat.find({
      participants: userId,
      isGroup: true,
    })
      .select('_id')
      .lean();
    const groupChatIds = groupChats.map((c) => c._id);

    const query = {
      $or: [
        { callerId: userId },
        { calleeId: userId },
        { isGroup: true, chatId: { $in: groupChatIds } },
      ],
    };

    const calls = await CallLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10))
      .populate('callerId', 'name phone avatarUrl')
      .populate('calleeId', 'name phone avatarUrl')
      .populate('chatId', 'groupName groupAvatarUrl')
      .populate('attendees', 'name phone avatarUrl')
      .lean();

    const total = await CallLog.countDocuments(query);

    const callList = calls.map((call) => {
      // ─── Group call ───────────────────────────────────────────────────
      if (call.isGroup) {
        const isCaller =
          call.callerId && call.callerId._id.toString() === userId;
        const attended = (call.attendees || []).some(
          (a) => a._id.toString() === userId
        );
        return {
          id: call._id,
          isGroup: true,
          chatId: call.chatId?._id || call.chatId || null,
          groupName: call.chatId?.groupName || 'Group',
          groupAvatarUrl: call.chatId?.groupAvatarUrl || '',
          caller: call.callerId,
          attendees: call.attendees || [],
          callType: call.callType || 'audio',
          type: isCaller ? 'outgoing' : attended ? 'incoming' : 'missed',
          timestamp: call.startedAt || call.createdAt,
          durationSeconds: call.durationSeconds || 0,
        };
      }

      // ─── 1-on-1 call ──────────────────────────────────────────────────
      const isCaller = call.callerId._id.toString() === userId;
      return {
        id: call._id,
        isGroup: false,
        peer: isCaller ? call.calleeId : call.callerId,
        callType: call.callType || 'audio',
        type: isCaller
          ? 'outgoing'
          : call.status === 'missed'
            ? 'missed'
            : 'incoming',
        timestamp: call.startedAt || call.createdAt,
        durationSeconds: call.durationSeconds || 0,
      };
    });

    res.status(200).json({
      calls: callList,
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

module.exports = { getCallHistory };
