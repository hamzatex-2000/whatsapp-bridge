/**
 * HTTL WhatsApp Bridge Server (Updated with Self-Ping)
 */

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios"); // Axios add kora hoyeche

// --- Config ---
const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PHONE = process.env.ADMIN_PHONE || "8801718097927";
// Render-er URL automatic neyar jonno
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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
  res.json({ status: "ok", whatsapp: waReady ? "connected" : "disconnected" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// --- WhatsApp Client ---
let waClient = null;
let waReady = false;
const adminConnections = new Set();

function initWhatsApp() {
  if (waClient) {
    try { waClient.destroy(); } catch {}
  }

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });

  waClient.on("qr", async (qr) => {
    console.log("QR code generated");
    const qrDataUrl = await QRCode.toDataURL(qr);
    broadcast({ type: "qr", qr: qrDataUrl });
  });

  waClient.on("ready", () => {
    console.log("WhatsApp client ready!");
    waReady = true;
    broadcast({ type: "ready" });
  });

  waClient.on("authenticated", () => {
    console.log("WhatsApp authenticated");
  });

  waClient.on("auth_failure", (msg) => {
    console.error("Auth failure:", msg);
    waReady = false;
    broadcast({ type: "disconnected", reason: "auth_failure" });
  });

  waClient.on("disconnected", (reason) => {
    console.log("WhatsApp disconnected:", reason);
    waReady = false;
    broadcast({ type: "disconnected", reason });
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
        console.error("Failed to save admin reply:", error);
      } else {
        console.log(`Admin replied to session ${sessionId}`);
      }
    } catch (err) {
      console.error("Error processing WA reply:", err);
    }
  });

  waClient.initialize().catch((err) => {
    console.error("WA init error:", err);
  });
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  adminConnections.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// --- WebSocket handlers ---
wss.on("connection", (ws) => {
  adminConnections.add(ws);
  console.log("Admin WebSocket connected");

  if (waReady) {
    ws.send(JSON.stringify({ type: "ready" }));
  } else {
    ws.send(JSON.stringify({ type: "disconnected" }));
  }

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "init") {
        if (!waClient || !waReady) {
          initWhatsApp();
        }
      }

      if (data.type === "logout") {
        if (waClient) {
          try { await waClient.logout(); } catch {}
          try { waClient.destroy(); } catch {}
          waClient = null;
          waReady = false;
          broadcast({ type: "disconnected", reason: "manual_logout" });
        }
      }

      if (data.type === "admin_reply" && waReady && waClient) {
        const phone = data.phone?.replace(/\D/g, "");
        if (phone && data.message) {
          const chatId = phone.includes("@c.us") ? phone : `${phone}@c.us`;
          await waClient.sendMessage(chatId, data.message);
          console.log(`Forwarded admin reply to WA: ${phone}`);
        }
      }
    } catch {}
  });

  ws.on("close", () => {
    adminConnections.delete(ws);
  });
});

// --- Supabase Realtime ---
const realtimeChannel = supabase
  .channel("new-visitor-messages")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "chat_messages", filter: "sender=eq.visitor" },
    async (payload) => {
      if (!waReady || !waClient) return;

      const msg = payload.new;
      const { data: session } = await supabase
        .from("chat_sessions")
        .select("*")
        .eq("id", msg.session_id)
        .single();

      if (!session) return;

      const adminChatId = `${ADMIN_PHONE.replace(/\D/g, "")}@c.us`;
      const formatted = `[Web Chat | ID: ${session.id}]\n👤 ${session.visitor_name}\n📱 ${session.visitor_phone}\n\n💬 ${msg.message}`;

      try {
        await waClient.sendMessage(adminChatId, formatted);
        console.log(`Forwarded visitor message to admin WA`);
      } catch (err) {
        console.error("Failed to forward to WA:", err);
      }
    }
  )
  .subscribe();

// --- 🛡️ SELF-PING MECHANISM 🛡️ ---
// Protite 10 minute por por server-ke call korbe jate Render ghumate na pare
setInterval(async () => {
  try {
    console.log(`Auto-ping: Keep-alive check for ${SELF_URL}/health`);
    await axios.get(`${SELF_URL}/health`);
  } catch (err) {
    console.error("Auto-ping failed:", err.message);
  }
}, 600000); // 10 minutes (600,000 ms)

// --- Start server ---
server.listen(PORT, () => {
  console.log(`HTTL WhatsApp Bridge running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://${SELF_URL}/ws`);
  console.log(`Health check: ${SELF_URL}/health`);
});
