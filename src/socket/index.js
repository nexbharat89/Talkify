const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const Message = require('../models/Message');
const Chat = require('../models/Chat');
const CallLog = require('../models/CallLog');
const { notifyNewMessage, notifyIncomingCall } = require('../services/pushService');

/**
 * Map of userId -> Set<socketId> for tracking active connections.
 * A user may have multiple sockets (multiple devices/tabs).
 */
const connectedUsers = new Map();

/**
 * Map of socketId -> userId for reverse lookup.
 */
const socketToUser = new Map();

/**
 * Initialize Socket.io on the HTTP server.
 */
const initSocketIO = (server) => {
  const io = require('socket.io')(server, {
    cors: {
      origin: config.corsOrigin,
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // =========================================================================
  // Authentication Middleware
  // =========================================================================
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.query.token || socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication token is required'));
      }

      const decoded = jwt.verify(token, config.jwt.accessSecret);
      socket.userId = decoded.userId;
      socket.phone = decoded.phone;

      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  // =========================================================================
  // Connection Handler
  // =========================================================================
  io.on('connection', async (socket) => {
    const userId = socket.userId;
    console.log(`[Socket] User connected: ${userId} (socket: ${socket.id})`);

    // Track connection
    if (!connectedUsers.has(userId)) {
      connectedUsers.set(userId, new Set());
    }
    connectedUsers.get(userId).add(socket.id);
    socketToUser.set(socket.id, userId);

    // Update user status to online
    await User.findByIdAndUpdate(userId, { status: 'online' });

    // Broadcast online status to all contacts
    await broadcastStatus(io, userId, 'online');

    // Catch-up delivery: mark messages that arrived while this user was
    // offline as 'delivered' and notify their senders (grey double-tick).
    await deliverPendingMessages(io, userId);

    // =======================================================================
    // Event: user:status:poll (client requests status of a contact)
    // =======================================================================
    socket.on('user:status:poll', async (data) => {
      try {
        const { userId: targetUserId } = data;
        const user = await User.findById(targetUserId).select('status lastSeen').lean();
        if (user) {
          socket.emit('user:status:update', {
            userId: targetUserId,
            status: isUserOnline(targetUserId) ? 'online' : 'offline',
            lastSeen: user.lastSeen,
          });
        }
      } catch (err) {
        console.error('[Socket] user:status:poll error:', err.message);
      }
    });

    // =======================================================================
    // Event: message:send
    // =======================================================================
    socket.on('message:send', async (data) => {
      try {
        const { chatId, type = 'text', content, tempId, media, forwardedFrom } = data;

        // Verify chat exists and user is participant
        const chat = await Chat.findOne({
          _id: chatId,
          participants: userId,
        }).populate('participants', 'name fcmTokens');

        if (!chat) {
          socket.emit('message:error', {
            tempId,
            error: 'Chat not found or access denied',
          });
          return;
        }

        // Create the message
        const message = await Message.create({
          chatId,
          senderId: userId,
          type,
          content: content || '',
          media: media || null,
          forwardedFrom: forwardedFrom || null,
          status: 'sent',
          deliveredTo: [],
          readBy: [],
        });

        // Update chat's last message
        const sender = chat.participants.find((p) => p._id.toString() === userId);
        chat.lastMessage = {
          messageId: message._id,
          content: message.content,
          type: message.type,
          senderId: userId,
          timestamp: message.createdAt,
        };

        // Reset unread for sender, increment for others
        chat.unreadCounts = chat.participants.map((p) => {
          if (p._id.toString() === userId) {
            return { userId: p._id, count: 0 };
          }
          const existing = chat.unreadCounts?.find(
            (uc) => uc.userId?.toString() === p._id.toString()
          );
          return { userId: p._id, count: (existing?.count || 0) + 1 };
        });

        await chat.save();

        // Ack to sender
        socket.emit('message:ack', {
          tempId,
          messageId: message._id,
          status: 'sent',
          timestamp: message.createdAt,
        });

        // Deliver to online recipients
        const recipientIds = chat.participants
          .filter((p) => p._id.toString() !== userId)
          .map((p) => p._id.toString());

        const populatedMessage = await Message.findById(message._id)
          .populate('senderId', 'name avatarUrl phone')
          .lean();

        const messagePayload = {
          messageId: populatedMessage._id,
          chatId,
          senderId: populatedMessage.senderId._id,
          senderName: populatedMessage.senderId.name,
          senderAvatar: populatedMessage.senderId.avatarUrl,
          type: populatedMessage.type,
          content: populatedMessage.content,
          media: populatedMessage.media,
          forwardedFrom: populatedMessage.forwardedFrom || null,
          reactions: [],
          timestamp: populatedMessage.createdAt,
        };

        for (const recipientId of recipientIds) {
          const recipientSockets = connectedUsers.get(recipientId);
          if (recipientSockets && recipientSockets.size > 0) {
            // Recipient is online - deliver via socket
            for (const sockId of recipientSockets) {
              io.to(sockId).emit('message:receive', messagePayload);
            }
            // Mark as delivered
            await Message.findByIdAndUpdate(message._id, {
              $addToSet: {
                deliveredTo: { userId: recipientId, deliveredAt: new Date() },
              },
              status: 'delivered',
            });
            // Notify the sender that the message was delivered (grey double-tick)
            const senderSockets = connectedUsers.get(userId);
            if (senderSockets) {
              for (const sockId of senderSockets) {
                io.to(sockId).emit('message:delivered', {
                  chatId,
                  messageId: message._id,
                  deliveredTo: recipientId,
                });
              }
            }
          } else {
            // Recipient is offline - send push notification
            const recipientUser = chat.participants.find(
              (p) => p._id.toString() === recipientId
            );
            if (recipientUser) {
              await notifyNewMessage(
                recipientUser,
                sender?.name || '',
                chatId,
                message.content,
                message.type
              );
            }
          }
        }

        // Broadcast updated chat list to all participants
        for (const participant of chat.participants) {
          const participantId = participant._id.toString();
          const participantSockets = connectedUsers.get(participantId);
          if (participantSockets) {
            for (const sockId of participantSockets) {
              io.to(sockId).emit('chat:updated', { chatId });
            }
          }
        }
      } catch (err) {
        console.error('[Socket] message:send error:', err.message);
        socket.emit('message:error', {
          tempId: data.tempId,
          error: 'Failed to send message',
        });
      }
    });

    // =======================================================================
    // Event: message:read
    // =======================================================================
    socket.on('message:read', async (data) => {
      try {
        const { chatId, messageIds } = data;

        if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        // Mark messages as read
        await Message.updateMany(
          {
            _id: { $in: messageIds },
            chatId,
            senderId: { $ne: userId },
          },
          {
            status: 'read',
            $addToSet: {
              readBy: { userId, readAt: new Date() },
            },
          }
        );

        // Reset unread count for this user
        await Chat.findOneAndUpdate(
          { _id: chatId, 'unreadCounts.userId': userId },
          { $set: { 'unreadCounts.$.count': 0 } }
        );

        // Notify senders that their messages were read
        const messages = await Message.find({ _id: { $in: messageIds } })
          .select('senderId')
          .lean();

        const senderIds = [...new Set(messages.map((m) => m.senderId.toString()))];
        for (const senderId of senderIds) {
          const senderSockets = connectedUsers.get(senderId);
          if (senderSockets) {
            for (const sockId of senderSockets) {
              io.to(sockId).emit('message:read:ack', {
                chatId,
                readBy: userId,
                messageIds,
                readAt: new Date(),
              });
            }
          }
        }

        // Broadcast chat updated
        socket.emit('chat:updated', { chatId });
      } catch (err) {
        console.error('[Socket] message:read error:', err.message);
      }
    });

    // =======================================================================
    // Event: message:react (toggle an emoji reaction on a message)
    // =======================================================================
    socket.on('message:react', async (data) => {
      try {
        const { messageId, emoji } = data;
        if (!messageId || !emoji) return;

        const message = await Message.findById(messageId);
        if (!message) return;

        // Verify the user participates in this chat
        const chat = await Chat.findOne({
          _id: message.chatId,
          participants: userId,
        }).select('participants').lean();
        if (!chat) return;

        // Toggle: same user + same emoji removes; otherwise replace this
        // user's existing reaction with the new emoji.
        const existingIdx = message.reactions.findIndex(
          (r) => r.userId?.toString() === userId
        );
        if (existingIdx >= 0 && message.reactions[existingIdx].emoji === emoji) {
          message.reactions.splice(existingIdx, 1);
        } else if (existingIdx >= 0) {
          message.reactions[existingIdx].emoji = emoji;
          message.reactions[existingIdx].createdAt = new Date();
        } else {
          message.reactions.push({ userId, emoji, createdAt: new Date() });
        }
        await message.save();

        const reactionsPayload = message.reactions.map((r) => ({
          userId: r.userId?.toString(),
          emoji: r.emoji,
        }));

        // Broadcast the updated reactions to every participant
        for (const participantId of chat.participants.map((p) => p.toString())) {
          const sockets = connectedUsers.get(participantId);
          if (sockets) {
            for (const sockId of sockets) {
              io.to(sockId).emit('message:reaction:update', {
                chatId: message.chatId,
                messageId: message._id,
                reactions: reactionsPayload,
              });
            }
          }
        }
      } catch (err) {
        console.error('[Socket] message:react error:', err.message);
      }
    });

    // =======================================================================
    // Event: chat:typing
    // =======================================================================
    socket.on('chat:typing', (data) => {
      const { chatId, isTyping } = data;

      // Find chat participants and relay typing status
      Chat.findById(chatId)
        .select('participants')
        .lean()
        .then((chat) => {
          if (!chat) return;
          const recipientIds = chat.participants
            .map((p) => p.toString())
            .filter((p) => p !== userId);

          for (const recipientId of recipientIds) {
            const recipientSockets = connectedUsers.get(recipientId);
            if (recipientSockets) {
              for (const sockId of recipientSockets) {
                io.to(sockId).emit('chat:typing', {
                  chatId,
                  userId,
                  isTyping,
                });
              }
            }
          }
        })
        .catch((err) => {
          console.error('[Socket] chat:typing error:', err.message);
        });
    });

    // =======================================================================
    // Event: call:initiate
    // =======================================================================
    socket.on('call:initiate', async (data) => {
      try {
        const { targetUserId, callType = 'audio', channelName } = data;

        const caller = await User.findById(userId).select('name avatarUrl phone').lean();
        const targetUser = await User.findById(targetUserId).select('fcmTokens').lean();

        if (!targetUser) {
          socket.emit('call:error', { error: 'Target user not found' });
          return;
        }

        // Create call log entry (pending)
        const callLog = await CallLog.create({
          callerId: userId,
          calleeId: targetUserId,
          channelName,
          callType,
          status: 'missed', // Default to missed until accepted
          startedAt: new Date(),
        });

        const callPayload = {
          callId: callLog._id,
          channelName,
          callType,
          caller: {
            id: userId,
            name: caller?.name || '',
            avatarUrl: caller?.avatarUrl || '',
          },
        };

        const targetSockets = connectedUsers.get(targetUserId);
        if (targetSockets && targetSockets.size > 0) {
          // Target is online - ring them via socket
          for (const sockId of targetSockets) {
            io.to(sockId).emit('call:incoming', callPayload);
          }

          // Tell the caller the receiver is ringing.
          const callerSockets = connectedUsers.get(userId);
          if (callerSockets) {
            for (const sockId of callerSockets) {
              io.to(sockId).emit('call:ringing', {
                callId: callLog._id,
                channelName,
              });
            }
          }
        }

        // Always also send a push so a backgrounded/terminated app shows the
        // native incoming-call UI. The client de-dupes by callId.
        await notifyIncomingCall(
          targetUser,
          caller?.name || '',
          callLog._id,
          channelName,
          {
            callerId: userId,
            callerAvatar: caller?.avatarUrl || '',
            callType,
          }
        );
      } catch (err) {
        console.error('[Socket] call:initiate error:', err.message);
        socket.emit('call:error', { error: 'Failed to initiate call' });
      }
    });

    // =======================================================================
    // Event: call:group:initiate (ring all other members of a group chat)
    // =======================================================================
    socket.on('call:group:initiate', async (data) => {
      try {
        const { chatId, channelName, callType = 'audio' } = data;

        const chat = await Chat.findOne({
          _id: chatId,
          participants: userId,
          isGroup: true,
        }).populate('participants', 'name avatarUrl fcmTokens').lean();

        if (!chat) {
          socket.emit('call:error', { error: 'Group not found' });
          return;
        }

        const caller = chat.participants.find(
          (p) => p._id.toString() === userId
        );

        const callLog = await CallLog.create({
          callerId: userId,
          chatId,
          isGroup: true,
          participants: [userId],
          channelName,
          callType,
          status: 'outgoing',
          startedAt: new Date(),
        });

        const callPayload = {
          callId: callLog._id,
          channelName,
          callType,
          isGroup: true,
          chatId,
          groupName: chat.groupName || 'Group',
          caller: {
            id: userId,
            name: caller?.name || '',
            avatarUrl: caller?.avatarUrl || '',
          },
        };

        const others = chat.participants.filter(
          (p) => p._id.toString() !== userId
        );

        let anyOnline = false;
        for (const member of others) {
          const memberId = member._id.toString();
          const memberSockets = connectedUsers.get(memberId);
          if (memberSockets && memberSockets.size > 0) {
            anyOnline = true;
            for (const sockId of memberSockets) {
              io.to(sockId).emit('call:incoming', callPayload);
            }
          }
          // Also push so backgrounded members ring
          await notifyIncomingCall(
            member,
            caller?.name || '',
            callLog._id,
            channelName,
            {
              callerId: userId,
              callerAvatar: caller?.avatarUrl || '',
              callType,
              isGroup: true,
              chatId,
              groupName: chat.groupName || 'Group',
            }
          );
        }

        // Tell the initiator the call is now ringing on at least one receiver.
        if (anyOnline) {
          const initiatorSockets = connectedUsers.get(userId);
          if (initiatorSockets) {
            for (const sockId of initiatorSockets) {
              io.to(sockId).emit('call:ringing', {
                callId: callLog._id,
                channelName,
              });
            }
          }
        }
      } catch (err) {
        console.error('[Socket] call:group:initiate error:', err.message);
        socket.emit('call:error', { error: 'Failed to initiate group call' });
      }
    });

    // =======================================================================
    // Event: call:group:join / call:group:leave (track membership)
    // =======================================================================
    socket.on('call:group:join', async (data) => {
      try {
        const { callId } = data;
        if (!callId) return;
        await CallLog.findByIdAndUpdate(callId, {
          $addToSet: { participants: userId },
        });
      } catch (err) {
        console.error('[Socket] call:group:join error:', err.message);
      }
    });

    socket.on('call:group:leave', async (data) => {
      try {
        const { callId } = data;
        if (!callId) return;
        const callLog = await CallLog.findById(callId);
        if (!callLog) return;
        callLog.participants = callLog.participants.filter(
          (p) => p.toString() !== userId
        );
        // When the last participant leaves, close the call out.
        if (callLog.participants.length === 0 && !callLog.endedAt) {
          callLog.endedAt = new Date();
        }
        await callLog.save();
      } catch (err) {
        console.error('[Socket] call:group:leave error:', err.message);
      }
    });

    // =======================================================================
    // Event: call:response
    // =======================================================================
    socket.on('call:response', async (data) => {
      try {
        const { callId, channelName, status } = data;

        const callLog = await CallLog.findById(callId);
        if (!callLog) {
          socket.emit('call:error', { error: 'Call not found' });
          return;
        }

        if (status === 'accepted') {
          callLog.status = callLog.calleeId.toString() === userId ? 'incoming' : 'outgoing';
          callLog.startedAt = new Date();
        } else {
          // rejected or missed
          callLog.endedAt = new Date();
          callLog.durationSeconds = 0;
        }
        await callLog.save();

        // Notify the caller about the response
        const callerId = callLog.callerId.toString();
        const callerSockets = connectedUsers.get(callerId);
        if (callerSockets) {
          for (const sockId of callerSockets) {
            io.to(sockId).emit('call:response:ack', {
              callId: callLog._id,
              channelName,
              status,
            });
          }
        }
      } catch (err) {
        console.error('[Socket] call:response error:', err.message);
        socket.emit('call:error', { error: 'Failed to process call response' });
      }
    });

    // =======================================================================
    // Event: call:end
    // =======================================================================
    socket.on('call:end', async (data) => {
      try {
        const { callId, channelName, durationSeconds = 0 } = data;

        // The caller may end an outgoing call while it is still ringing, at
        // which point it only knows the channelName (the callId is delivered
        // back via call:response:ack only after the callee answers). Resolve
        // by id when present, otherwise fall back to the channel.
        let callLog = null;
        if (callId) {
          callLog = await CallLog.findById(callId);
        } else if (channelName) {
          callLog = await CallLog.findOne({ channelName }).sort({ createdAt: -1 });
        }
        if (!callLog) {
          socket.emit('call:error', { error: 'Call not found' });
          return;
        }

        // Stamp the end time. We deliberately do NOT touch `status`: an
        // outgoing call that was never accepted stays 'missed', so the callee
        // still gets a missed-call entry in their history.
        callLog.endedAt = new Date();
        callLog.durationSeconds = durationSeconds;
        await callLog.save();

        const endedPayload = {
          callId: callLog._id,
          channelName: callLog.channelName,
          durationSeconds,
        };

        // Notify BOTH parties so whichever side did not hang up tears down its
        // UI — the ringing CallKit screen on the callee, or the active/ringing
        // screen on either peer. Emitting to the ender too is harmless (their
        // screen is already gone) and keeps multi-device sessions in sync.
        const partyIds = [
          callLog.callerId.toString(),
          callLog.calleeId ? callLog.calleeId.toString() : null,
        ].filter(Boolean);

        for (const partyId of partyIds) {
          const partySockets = connectedUsers.get(partyId);
          if (partySockets) {
            for (const sockId of partySockets) {
              io.to(sockId).emit('call:ended', endedPayload);
            }
          }
        }
      } catch (err) {
        console.error('[Socket] call:end error:', err.message);
      }
    });

    // =======================================================================
    // Disconnect Handler
    // =======================================================================
    socket.on('disconnect', async () => {
      console.log(`[Socket] User disconnected: ${userId} (socket: ${socket.id})`);

      // Remove socket tracking
      const userSockets = connectedUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          connectedUsers.delete(userId);
          // User has no more active sockets - mark offline
          await User.findByIdAndUpdate(userId, {
            status: 'offline',
            lastSeen: new Date(),
          });

          // Broadcast offline to contacts
          await broadcastStatus(io, userId, 'offline');
        }
      }
      socketToUser.delete(socket.id);
    });
  });

  return io;
};

// ===========================================================================
// Helper: Check if a user is online
// ===========================================================================
const isUserOnline = (userId) => {
  const sockets = connectedUsers.get(userId);
  return sockets && sockets.size > 0;
};

// ===========================================================================
// Helper: Mark messages delivered to a freshly-connected user and notify
// their senders so the sender's UI updates to the grey double-tick.
// ===========================================================================
const deliverPendingMessages = async (io, userId) => {
  try {
    // Chats this user participates in
    const chats = await Chat.find({ participants: userId }).select('_id').lean();
    const chatIds = chats.map((c) => c._id);
    if (chatIds.length === 0) return;

    // Messages sent by others, still 'sent', not yet delivered to this user
    const pending = await Message.find({
      chatId: { $in: chatIds },
      senderId: { $ne: userId },
      status: 'sent',
      'deliveredTo.userId': { $ne: userId },
    })
      .select('_id chatId senderId')
      .lean();

    if (pending.length === 0) return;

    const now = new Date();
    await Message.updateMany(
      { _id: { $in: pending.map((m) => m._id) } },
      {
        status: 'delivered',
        $addToSet: { deliveredTo: { userId, deliveredAt: now } },
      }
    );

    // Notify each original sender that their message was delivered
    for (const msg of pending) {
      const senderSockets = connectedUsers.get(msg.senderId.toString());
      if (senderSockets) {
        for (const sockId of senderSockets) {
          io.to(sockId).emit('message:delivered', {
            chatId: msg.chatId,
            messageId: msg._id,
            deliveredTo: userId,
          });
        }
      }
    }
  } catch (err) {
    console.error('[Socket] deliverPendingMessages error:', err.message);
  }
};

// ===========================================================================
// Helper: Broadcast user status to their contacts
// ===========================================================================
const broadcastStatus = async (io, userId, status) => {
  try {
    // Find all chats this user participates in
    const chats = await Chat.find({ participants: userId }).select('participants').lean();

    const contactIds = new Set();
    for (const chat of chats) {
      for (const p of chat.participants) {
        const pId = p.toString();
        if (pId !== userId) {
          contactIds.add(pId);
        }
      }
    }

    const lastSeen = status === 'offline' ? new Date() : null;

    for (const contactId of contactIds) {
      const contactSockets = connectedUsers.get(contactId);
      if (contactSockets) {
        const payload = {
          userId,
          status,
          ...(lastSeen && { lastSeen }),
        };
        for (const sockId of contactSockets) {
          io.to(sockId).emit('user:status:update', payload);
        }
      }
    }
  } catch (err) {
    console.error('[Socket] broadcastStatus error:', err.message);
  }
};

module.exports = { initSocketIO, isUserOnline, connectedUsers };