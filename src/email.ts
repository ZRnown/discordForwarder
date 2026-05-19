import nodemailer from "nodemailer";
import { getEnv } from "./env.js";

interface EmailOptions {
  to?: string;
  subject: string;
  text: string;
  html?: string;
}

export class EmailService {
  private env = getEnv();
  private enabled: boolean;
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    this.enabled = this.env.EMAIL_ENABLED === "true";
    if (this.enabled) {
      this.initTransporter();
    }
  }

  private initTransporter() {
    const {
      EMAIL_SMTP_HOST,
      EMAIL_SMTP_PORT,
      EMAIL_SMTP_SECURE,
      EMAIL_SMTP_USER,
      EMAIL_SMTP_PASS
    } = this.env;

    if (!EMAIL_SMTP_HOST || !EMAIL_SMTP_USER || !EMAIL_SMTP_PASS) {
      console.error("[Email] Missing required email configuration");
      this.enabled = false;
      return;
    }

    const port = parseInt(EMAIL_SMTP_PORT || "465", 10);
    const secure =
      EMAIL_SMTP_SECURE !== "false" && (port === 465 || port === 587);

    this.transporter = nodemailer.createTransport({
      host: EMAIL_SMTP_HOST,
      port,
      secure,
      auth: {
        user: EMAIL_SMTP_USER,
        pass: EMAIL_SMTP_PASS
      }
    });
  }

  async send(options: EmailOptions): Promise<boolean> {
    if (!this.enabled || !this.transporter) {
      console.log("[Email] Email service is disabled or not configured");
      return false;
    }

    const { EMAIL_FROM, EMAIL_TO } = this.env;
    const to = options.to || EMAIL_TO || EMAIL_FROM;
    const from = EMAIL_FROM || this.env.EMAIL_SMTP_USER;

    if (!to) {
      console.error("[Email] No recipient email address");
      return false;
    }

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: options.subject,
        text: options.text,
        html: options.html || options.text.replace(/\n/g, "<br>")
      });
      if (process.env.LOG_LEVEL !== "error")
        console.log(`[Email] Email sent successfully to ${to}`);
      return true;
    } catch (error) {
      console.error("[Email] Failed to send email:", error);
      return false;
    }
  }
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  const service = new EmailService();
  return await service.send(options);
}
