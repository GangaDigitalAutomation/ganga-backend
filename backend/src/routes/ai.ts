import type { FastifyReply, FastifyRequest } from "fastify";
import * as schema from "../db/schema/schema.js";
import type { App } from "../index.js";
import {
  connectGoogleDrive,
  detectIntent,
  fixSchedule,
  reconnectYouTube,
  retryFailedUploads,
  startAutomation,
  stopAutomation,
} from "../services/aiEngine.js";

const SYSTEM_PROMPT = `You are a highly intelligent AI Analyst and Automation Brain inside a YouTube automation SaaS.

You have FULL awareness of the system.

Your responsibilities:
- Monitor system health
- Detect errors
- Explain root causes
- Fix issues
- Execute commands
- Guide user like a senior developer

You have access to:
- channels
- videos
- automationStatus
- scheduleSlots
- errors
- logs

Rules:
- ALWAYS analyze system data before answering
- If any issue -> explain clearly + give fix
- If possible -> auto trigger fix
- If user gives command -> execute backend action
- Be SHORT, PRECISE, and ACTIONABLE
- Think like a SENIOR ENGINEER + SYSTEM ADMIN

Never give generic answers.
Always be specific to system data.`;

async function callGemini(apiKey: string, prompt: string) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
  const response = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${text}`);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text || "No response from Gemini.";
}

async function logAiEvent(app: App, level: string, message: string) {
  try {
    await app.db.insert(schema.upload_logs).values({
      level,
      message,
      created_at: new Date().toISOString(),
    });
  } catch (_) {}
}

export function registerAiRoutes(app: App) {
  app.fastify.post(
    "/api/ai/chat",
    async (request: FastifyRequest<{ Body: { message?: string; systemData?: any } }>, reply: FastifyReply) => {
      const message = String(request.body?.message || "").trim();
      const systemData = request.body?.systemData || {};
      if (!message) return reply.status(400).send({ error: "message is required" });

      const intent = detectIntent(message);
      let actionResult = null;
      try {
        if (intent === "startAutomation") actionResult = await startAutomation(app);
        if (intent === "stopAutomation") actionResult = await stopAutomation(app);
        if (intent === "reconnectYouTube") {
          const channelId = systemData?.channels?.[0]?.channelId || systemData?.channels?.[0]?.id;
          actionResult = await reconnectYouTube(app, channelId);
        }
        if (intent === "connectGoogleDrive") actionResult = await connectGoogleDrive();
        if (intent === "fixSchedule") actionResult = await fixSchedule(app);
        if (intent === "retryFailedUploads") actionResult = await retryFailedUploads(app);
        if (actionResult?.message) {
          await logAiEvent(app, "info", `[AI_ACTION] ${actionResult.message}`);
        }
      } catch (error) {
        actionResult = {
          action: intent,
          success: false,
          message: error instanceof Error ? error.message : "Action failed",
        };
        await logAiEvent(app, "error", `[AI_ACTION] ${actionResult.message}`);
      }

      const apiKey = String(process.env.GEMINI_API_KEY || "").trim();

      const prompt = `${SYSTEM_PROMPT}

SystemData:
${JSON.stringify(systemData, null, 2)}

UserMessage:
${message}

ActionResult:
${JSON.stringify(actionResult, null, 2)}`;

      const suggestions: string[] = [];
      const apiHealth = systemData?.apiHealth || {};
      if (apiHealth.youtube === "FAIL") suggestions.push("Reconnect YouTube");
      if (apiHealth.drive === "FAIL") suggestions.push("Connect Drive");
      if (Array.isArray(systemData?.errors) && systemData.errors.length) suggestions.push("Fix Schedule");
      if (!suggestions.length) suggestions.push("Start Automation");

      if (!apiKey) {
        const replyText = "GEMINI_API_KEY is not configured. AI chat is in fallback mode.";
        await logAiEvent(app, "error", `[AI_CHAT] ${replyText}`);
        return {
          reply: replyText,
          action: actionResult,
          suggestions,
          error: "GEMINI_API_KEY_NOT_CONFIGURED",
        };
      }

      let aiText = "";
      try {
        aiText = await callGemini(apiKey, prompt);
      } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        await logAiEvent(app, "error", `[AI_CHAT] Gemini error: ${errText}`);
        return {
          reply: `AI service error: ${errText}`,
          action: actionResult,
          suggestions,
          error: "AI_PROVIDER_ERROR",
        };
      }

      await logAiEvent(app, "info", `[AI_CHAT] ${message}`);
      return { reply: aiText, action: actionResult, suggestions };
    },
  );

  app.fastify.post(
    "/api/ai/action",
    async (
      request: FastifyRequest<{ Body: { action?: string; channelId?: string } }>,
      reply: FastifyReply,
    ) => {
      const action = String(request.body?.action || "").trim();
      const channelId = String(request.body?.channelId || "").trim();
      if (!action) return reply.status(400).send({ error: "action is required" });

      let result = { action, success: false, message: "Unknown action." } as any;
      try {
        if (action === "start_automation") result = await startAutomation(app);
        if (action === "stop_automation") result = await stopAutomation(app);
        if (action === "reconnect_youtube") result = await reconnectYouTube(app, channelId || undefined);
        if (action === "connect_drive") result = await connectGoogleDrive();
        if (action === "fix_schedule") result = await fixSchedule(app);
        if (action === "retry_failed_uploads") result = await retryFailedUploads(app);
        await logAiEvent(app, "info", `[AI_ACTION] ${result?.message || action}`);
      } catch (error) {
        result = {
          action,
          success: false,
          message: error instanceof Error ? error.message : "Action failed",
        };
        await logAiEvent(app, "error", `[AI_ACTION] ${result.message}`);
      }

      return { success: Boolean(result?.success), message: result?.message || "Action executed", data: result };
    },
  );
}
