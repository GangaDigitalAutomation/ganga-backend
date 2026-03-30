import jwt from "jsonwebtoken";
import type { App } from "../core/createApp.js";

type SessionPayload = {
  sub: string;
  email: string;
  is_allowed: boolean;
};

export function signSession(app: App, payload: SessionPayload) {
  return jwt.sign(payload, app.env.jwtSecret, { expiresIn: "7d" });
}

export function verifySession(app: App, token: string) {
  return jwt.verify(token, app.env.jwtSecret) as SessionPayload;
}

