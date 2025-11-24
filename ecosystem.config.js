// PM2 ecosystem configuration for Discord Forwarder bot
// - Runs the bot from compiled output (dist/index.js)
// - Routes PM2 logs to ./logs and shows timestamps
// - Configures pm2-logrotate to keep logs only for N days (default 7)

const LOG_KEEP_DAYS = parseInt(
  process.env.LOG_KEEP_DAYS || process.env.PM2_LOG_KEEP_DAYS || "7",
  10
);
const LOG_MAX_SIZE = String(process.env.PM2_LOG_MAX_SIZE || process.env.LOG_MAX_SIZE || "20M");

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
      // Merge stdout/stderr into the same file if desired
      merge_logs: true,
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      env: {
        // You can set/override envs here if needed. The app also reads from .env
        // DISCORD_TOKEN: "",
        // PROXY_URL: "",
        // LOG_LEVEL: "info",
        // LOG_KEEP_DAYS: String(LOG_KEEP_DAYS),
      },
    },
  ],

  // Configure PM2 modules
  module_conf: {
    // pm2-logrotate configuration: keep logs by days
    // Note: make sure to install the module:
    //   pm2 install pm2-logrotate
    "pm2-logrotate": {
      max_days: LOG_KEEP_DAYS, // keep only N days of logs
      compress: true, // gzip old logs
      dateFormat: "YYYY-MM-DD",
      workerInterval: "30", // check every 30 sec
      rotateInterval: "0 0 * * *", // rotate daily at 00:00
      rotateModule: true, // rotate PM2 internal logs as well
      // Size-based rotate in addition to daily schedule
      max_size: LOG_MAX_SIZE,
    },
  },
};
