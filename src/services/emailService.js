const nodemailer = require('nodemailer');
const config = require('../config');
const { createError } = require('../middleware/errorHandler');

/**
 * Lazily-created singleton Gmail SMTP transporter.
 *
 * Uses an App Password (config.smtp.pass) — a regular Gmail password will be
 * rejected. The transporter is reused across requests to avoid reconnecting.
 */
let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  if (!config.smtp.user || !config.smtp.pass) {
    throw createError(500, 'Email service is not configured (missing SMTP_USER / SMTP_PASS).');
  }

  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // TLS
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  return transporter;
};

/**
 * Send a 6-digit OTP to the given email address.
 * Throws a 502 if the message cannot be delivered.
 */
const sendOtpEmail = async (toEmail, otp) => {
  const from = `"${config.smtp.fromName}" <${config.smtp.user}>`;

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="margin: 0 0 8px;">Your ${config.smtp.fromName} verification code</h2>
      <p style="margin: 0 0 24px; color: #555;">Use the code below to sign in. It expires in ${config.smtp.otpExpiryMinutes} minutes.</p>
      <div style="font-size: 36px; font-weight: 700; letter-spacing: 10px; text-align: center; background: #f1f5f3; border-radius: 12px; padding: 20px 0; color: #16a34a;">
        ${otp}
      </div>
      <p style="margin: 24px 0 0; color: #888; font-size: 13px;">If you didn't request this code, you can safely ignore this email.</p>
    </div>
  `;

  try {
    await getTransporter().sendMail({
      from,
      to: toEmail,
      subject: `${otp} is your ${config.smtp.fromName} verification code`,
      text: `Your ${config.smtp.fromName} verification code is ${otp}. It expires in ${config.smtp.otpExpiryMinutes} minutes.`,
      html,
    });
    console.log(`[Email OTP] Sent OTP email to ${toEmail}`);
  } catch (error) {
    if (error.statusCode) throw error;
    console.error('[Email OTP] Failed to send:', error.message);
    throw createError(502, 'Failed to send OTP email. Please try again.');
  }
};

module.exports = { sendOtpEmail };
