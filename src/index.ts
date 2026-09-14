import { Hono } from "hono";
import type { Env } from "./types";
import { authRoutes } from "./routes/auth";
import { playerRoutes } from "./routes/players";
import { dayRoutes } from "./routes/days";
import { ocrRoutes } from "./routes/ocr";
import { statsRoutes } from "./routes/stats";

const app = new Hono<{ Bindings: Env }>();

app.route("/", authRoutes);
app.route("/", playerRoutes);
app.route("/", dayRoutes);
app.route("/", ocrRoutes);
app.route("/", statsRoutes);

export default app;
