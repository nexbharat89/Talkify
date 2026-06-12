const { Router } = require('express');
const authenticate = require('../middleware/auth');
const { generateAgoraToken } = require('../services/agoraService');
const { getCallHistory, rejectCallController } = require('../services/callService');
const { testPush } = require('../services/pushService');

const router = Router();

// All call routes require authentication
router.use(authenticate);

router.post('/agora-token', generateAgoraToken);
router.get('/history', getCallHistory);
router.post('/test-push', testPush);
router.post('/:callId/reject', rejectCallController);

module.exports = router;