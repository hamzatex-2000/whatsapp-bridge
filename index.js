/**
 * HTTL WhatsApp Bridge Server
 * 
 * Deploy this on any Node.js host (cPanel, Railway, Render, VPS).
 * It bridges website chat ↔ WhatsApp using whatsapp-web.js.
 *
 * Environment variables required:
 *   SUPABASE_URL          - Your Supabase project URL
 *   SUPABASE_SERVICE_KEY  - Your Supabase service_role key
 *   ADMIN_PHONE           - Admin WhatsApp number (e.g., 8801718097927)
 *   PORT                  - Server port (default: 3001)
 *   PUPPETEER_EXECUTABLE_PATH - (optional) Path to Chrome/Chromium binary
 */

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");

// --- Config ---
const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || "8801718097927").replace(/\D/g, "");

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Internal state ---
// idle | initializing | waiting_scan | connected | disconnected | error
let waState = "idle";
let lastError = null;
let lastEventAt = null;
let isInitializing = false;

// --- Express + WebSocket ---
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    whatsapp: waState === "connected" ? "connected" : "disconnected",
    state: waState,
    lastError,
    lastEventAt,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// --- WhatsApp Client ---
let waClient = null;
const adminConnections = new Set();

function updateState(newState, error) {
  waState = newState;
  lastEventAt = new Date().toISOString();
  if (error) lastError = error;
  console.log(`[WA State] ${newState}${error ? ` — ${error}` : ""}`);
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  adminConnections.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function broadcastStatus(status, extra) {
  broadcast({ type: "status", status, ...extra });
}

function initWhatsApp() {
  // Guard: prevent double init
  if (isInitializing) {
    console.log("[WA] Already initializing, skipping duplicate init");
    return;
  }

  isInitializing = true;
  updateState("initializing");
  broadcastStatus("initializing");

  if (waClient) {
    try { waClient.destroy(); } catch {}
    waClient = null;
  }

  const puppeteerArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: puppeteerArgs,
      ...(executablePath ? { executablePath } : {}),
    },
  });

  waClient.on("qr", async (qr) => {
    console.log("[WA] QR code generated");
    updateState("waiting_scan");
    const qrDataUrl = await QRCode.toDataURL(qr);
    broadcast({ type: "qr", qr: qrDataUrl });
    broadcastStatus("waiting_scan");
  });

  waClient.on("ready", () => {
    console.log("[WA] Client ready!");
    isInitializing = false;
    updateState("connected");
    broadcast({ type: "ready" });
    broadcastStatus("connected");
  });

  waClient.on("authenticated", () => {
    console.log("[WA] Authenticated");
  });

  waClient.on("auth_failure", (msg) => {
    console.error("[WA] Auth failure:", msg);
    isInitializing = false;
    updateState("error", `auth_failure: ${msg}`);
    broadcast({ type: "error", reason: "auth_failure", detail: String(msg) });
    broadcastStatus("error", { reason: "auth_failure" });
  });

  waClient.on("disconnected", (reason) => {
    console.log("[WA] Disconnected:", reason);
    isInitializing = false;
    updateState("disconnected", reason);
    broadcast({ type: "disconnected", reason });
    broadcastStatus("disconnected", { reason });
  });

  // Listen for admin replies on WhatsApp
  waClient.on("message", async (msg) => {
    if (!msg.hasQuotedMsg) return;
    try {
      const quoted = await msg.getQuotedMessage();
      const quotedBody = quoted.body || "";
      const match = quotedBody.match(/\[Web Chat \| ID: ([^\]]+)\]/);
      if (!match) return;

      const sessionId = match[1];
      const replyText = msg.body;

      const { error } = await supabase.from("chat_messages").insert({
        session_id: sessionId,
        sender: "admin",
        message: replyText,
      });

      if (error) {
        console.error("[WA] Failed to save admin reply:", error);
      } else {
        console.log(`[WA] Admin replied to session ${sessionId}`);
      }
    } catch (err) {
      console.error("[WA] Error processing reply:", err);
    }
  });

  waClient.initialize().then(() => {
    console.log("[WA] initialize() resolved");
  }).catch((err) => {
    console.error("[WA] Initialize failed:", err);
    isInitializing = false;
    updateState("error", String(err));
    broadcast({ type: "error", reason: "init_failed", detail: String(err) });
    broadcastStatus("error", { reason: "init_failed", detail: String(err) });
  });
}

// --- WebSocket handlers ---
wss.on("connection", (ws) => {
  adminConnections.add(ws);
  console.log("[WS] Admin connected");

  // Send current state — do NOT send "disconnected" generically
  if (waState === "connected") {
    ws.send(JSON.stringify({ type: "status", status: "connected" }));
  } else if (waState === "waiting_scan") {
    ws.send(JSON.stringify({ type: "status", status: "waiting_scan" }));
  } else if (waState === "initializing") {
    ws.send(JSON.stringify({ type: "status", status: "initializing" }));
  } else {
    // idle or disconnected — send idle so frontend knows server is reachable but WA not linked
    ws.send(JSON.stringify({ type: "status", status: "idle" }));
  }

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "init") {
        if (waState !== "connected" && !isInitializing) {
          initWhatsApp();
        } else if (waState === "connected") {
          ws.send(JSON.stringify({ type: "status", status: "connected" }));
        } else if (isInitializing) {
          ws.send(JSON.stringify({ type: "status", status: "initializing" }));
        }
      }

      if (data.type === "logout") {
        if (waClient) {
          try { await waClient.logout(); } catch {}
          try { waClient.destroy(); } catch {}
          waClient = null;
          isInitializing = false;
          updateState("disconnected", "manual_logout");
          broadcast({ type: "disconnected", reason: "manual_logout" });
          broadcastStatus("disconnected", { reason: "manual_logout" });
        }
      }

      if (data.type === "admin_reply" && waState === "connected" && waClient) {
        const phone = data.phone?.replace(/\D/g, "");
        if (phone && data.message) {
          const chatId = phone.includes("@c.us") ? phone : `${phone}@c.us`;
          await waClient.sendMessage(chatId, data.message);
          console.log(`[WA] Forwarded admin reply to: ${phone}`);
        }
      }
    } catch {}
  });

  ws.on("close", () => {
    adminConnections.delete(ws);
    console.log("[WS] Admin disconnected");
  });
});

// --- Supabase Realtime: listen for new visitor messages ---
const realtimeChannel = supabase
  .channel("new-visitor-messages")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "chat_messages", filter: "sender=eq.visitor" },
    async (payload) => {
      if (waState !== "connected" || !waClient) return;

      const msg = payload.new;
      const { data: session } = await supabase
        .from("chat_sessions")
        .select("*")
        .eq("id", msg.session_id)
        .single();

      if (!session) return;

      const adminChatId = `${ADMIN_PHONE}@c.us`;
      const formatted = `[Web Chat | ID: ${session.id}]\n👤 ${session.visitor_name}\n📱 ${session.visitor_phone}\n\n💬 ${msg.message}`;

      try {
        await waClient.sendMessage(adminChatId, formatted);
        console.log("[WA] Forwarded visitor message to admin");
      } catch (err) {
        console.error("[WA] Failed to forward:", err);
      }
    }
  )
  .subscribe();

// --- Self-ping to prevent Render free tier from sleeping ---
function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    require("http").get(`${url}/health`, () => {}).on("error", () => {});
  }, 14 * 60 * 1000);
}

// --- Start server ---
server.listen(PORT, () => {
  console.log(`[Server] HTTL WhatsApp Bridge running on port ${PORT}`);
  console.log(`[Server] WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);
  selfPing();
});
