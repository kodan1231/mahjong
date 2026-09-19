import { Hono } from "hono";
import type { Env } from "./types";
import { authRoutes } from "./routes/auth";
import { playerRoutes } from "./routes/players";
import { dayRoutes } from "./routes/days";
import { statsRoutes } from "./routes/stats";
import { iconRoutes } from "./routes/icon";

const app = new Hono<{ Bindings: Env }>();

app.route("/", authRoutes);
app.route("/", playerRoutes);
app.route("/", dayRoutes);
app.route("/", statsRoutes);
app.route("/", iconRoutes);

export default app;
