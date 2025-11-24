// PM2 ecosystem configuration for Discord Forwarder bot (CommonJS)
// - Runs the bot via run.sh (build before run)
// - PM2 logs rotated by days and size via pm2-logrotate

const LOG_KEEP_DAYS = parseInt(
  process.env.LOG_KEEP_DAYS || process.env.PM2_LOG_KEEP_DAYS || "7",
  10
);
const LOG_MAX_SIZE = String(
  process.env.PM2_LOG_MAX_SIZE || process.env.LOG_MAX_SIZE || "20M"
);

module.exports = {
  apps: [
    {
      name: "discord-forwarder-bot",
      script: "./run.sh",
      interpreter: "bash",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      merge_logs: true,
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
    },
  ],

  module_conf: {
    "pm2-logrotate": {
      max_days: LOG_KEEP_DAYS,
      compress: true,
      dateFormat: "YYYY-MM-DD",
      workerInterval: "30",
      rotateInterval: "0 0 * * *",
      rotateModule: true,
      max_size: LOG_MAX_SIZE,
    },
  },
};
