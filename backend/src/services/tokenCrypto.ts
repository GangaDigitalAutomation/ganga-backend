import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!secret || secret.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be set and at least 32 characters long");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptToken(value: string) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
}

export function decryptToken(payload: string) {
  const key = getKey();
  const [ivHex, contentHex, tagHex] = String(payload || "").split(":");
  if (!ivHex || !contentHex || !tagHex) {
    throw new Error("Invalid encrypted token payload");
  }
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(contentHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
