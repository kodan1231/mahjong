export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  AI: Ai;
  APP_TIMEZONE: string;
  ADMIN_PASSWORD: string;
  AUTH_SECRET: string;
}
