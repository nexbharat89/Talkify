const dotenv = require('dotenv');
dotenv.config();

const config = {
  // Server
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',

  // MongoDB
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/talkify',

  // JWT
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret',
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',
    refreshExpiryMs: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
  },

  // Msg91
  msg91: {
    useRealApi: process.env.MSG91_USE_REAL_API === 'true',
    authKey: process.env.MSG91_AUTH_KEY || '',
    senderId: process.env.MSG91_SENDER_ID || 'TALKFY',
    templateId: process.env.MSG91_TEMPLATE_ID || '',
    otpExpiryMinutes: 5,
  },

  // SMTP (Email OTP delivery via Gmail)
  smtp: {
    user: process.env.SMTP_USER || '',
    // Gmail App Passwords are displayed with spaces — strip them so auth works.
    pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    fromName: process.env.SMTP_FROM_NAME || 'Mittal',
    otpExpiryMinutes: 5,
  },

  // ImageKit
  imagekit: {
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY || '',
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY || '',
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || '',
  },

  // Agora
  agora: {
    appId: process.env.AGORA_APP_ID || '',
    appCertificate: process.env.AGORA_APP_CERTIFICATE || '',
    tokenExpirySeconds: 3600, // 1 hour
  },

  // Firebase
  fcm: {
    projectId: process.env.FCM_PROJECT_ID || '',
    clientEmail: process.env.FCM_CLIENT_EMAIL || '',
    privateKey: (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  },

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || '*',
};

module.exports = config;