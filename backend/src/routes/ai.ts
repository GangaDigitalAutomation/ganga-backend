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
  connectChannel,
  updateContentSettingsAi,
} from "../services/aiEngine.js";

const SYSTEM_PROMPT = `You are Ganga AI, a highly intelligent, conversational, and versatile AI assistant (similar to ChatGPT or Gemini).

Your personality and abilities:
- You are friendly, conversational, and act like a helpful human assistant.
- You can chat about ANYTHING: answer general knowledge questions, write code, tell jokes, or engage in casual conversation. Act exactly like a normal, unrestricted AI.
- In addition to being a general-purpose AI, you also have the special superpower of managing the user's YouTube Automation SaaS.

System Management Rules:
- You have access to system status (channels, videos, logs). Use this ONLY IF the user asks about the system, their videos, or their channels.
- If the user asks a general question (e.g. "how to make a video", "what is the capital of France"), just answer it normally. DO NOT mention their system data unless it's relevant.
- If the user gives a clear command like "connect my channel" or "save these titles", use your tools to execute those actions.`;

async function callGemini(apiKey: string, prompt: string, systemData: any) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";
  const response = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "System Data:\n" + JSON.stringify(systemData, null, 2) + "\n\n" + SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "connect_channel",
              description: "Adds a YouTube channel to the database. Needs API Client ID and Secret.",
              parameters: {
                 type: "OBJECT",
                 properties: {
                    channelName: { type: "STRING" },
                    clientId: { type: "STRING" },
                    clientSecret: { type: "STRING" }
                 },
                 required: ["channelName", "clientId", "clientSecret"]
              }
            },
            {
              name: "update_content_settings",
              description: "Updates the auto-scheduler's Title, Description, and Tags list in the system. Use this when the user asks you to save or push generated titles/tags/descriptions into the system.",
              parameters: {
                 type: "OBJECT",
                 properties: {
                    titles: {
                        type: "ARRAY",
                        items: { type: "STRING" },
                        description: "A list of strings. Each is a catchy video title."
                    },
                    description: { type: "STRING", description: "The default video description." },
                    tags: {
                        type: "ARRAY",
                        items: { type: "STRING" },
                        description: "A list of strings. Each is a tag."
                    }
                 }
              }
            }
          ]
        }
      ]
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${text}`);
  }
  const data = await response.json();
  const functionCall = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall)?.functionCall;
  if (functionCall) {
    return { isFunctionCall: true, functionCall };
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return { isFunctionCall: false, text: text || "No response from Gemini." };
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

      const apiKey = String(process.env.GEMINI_API_KEY || "AIzaSyAC_k8vAJ95d0aRjD6RCw1tzXl7n9BK2Io").trim();

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
        const geminiRes = await callGemini(apiKey, message, systemData);
        if (geminiRes.isFunctionCall) {
            const func = geminiRes.functionCall;
            if (func.name === "connect_channel") {
                const args = func.args || {};
                actionResult = await connectChannel(app, args.channelName, args.clientId, args.clientSecret);
                aiText = `Got it! I have added your channel "${args.channelName}" to the system database. You can now authorize it from your dashboard.`;
                await logAiEvent(app, "info", `[AI_ACTION] ${actionResult.message}`);
            } else if (func.name === "update_content_settings") {
                const args = func.args || {};
                actionResult = await updateContentSettingsAi(args.titles, args.description, args.tags);
                aiText = `Done! I have pushed the requested titles/settings directly into your Automation Content Settings. They are ready to be used for the next schedule!`;
                await logAiEvent(app, "info", `[AI_ACTION] ${actionResult.message}`);
            } else {
                aiText = "Executed tool: " + func.name;
            }
        } else {
            aiText = geminiRes.text;
        }
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
