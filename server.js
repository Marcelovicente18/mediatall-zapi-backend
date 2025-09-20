
import express from "express";
import cors from "cors";

// Uses Node 18+ global fetch (no node-fetch dependency)
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ====== ENV ======
// Example:
// ZAPI_BASE=https://api.z-api.io/instances/INSTANCE_ID
// ZAPI_TOKEN=YOUR_TOKEN
// AUTH_TOKEN=someStrongSecret   (optional)
// READ_ONLY=1                   (recommended to reduce risk; disables /send)
const ZAPI_BASE = process.env.ZAPI_BASE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const READ_ONLY = process.env.READ_ONLY === "1";

// Simple in-memory storage (OK to start).
// For persistence, wire these writes to Supabase or a DB.
const Chats = new Map();     // chatId -> { chatId, name, phone, lastTs, avatarUrl, preview }
const Messages = new Map();  // chatId -> [ { id, fromMe, type, text, mediaUrl, ts } ]

function upsertChat({ chatId, name, phone, ts, avatarUrl, preview }) {
  const prev = Chats.get(chatId) || { chatId };
  Chats.set(chatId, {
    chatId,
    name: name || prev.name || phone || chatId,
    phone: phone || prev.phone || "",
    lastTs: Math.max(prev.lastTs || 0, ts || 0),
    avatarUrl: avatarUrl ?? prev.avatarUrl ?? null,
    preview: preview ?? prev.preview ?? null
  });
}

function pushMessage(chatId, msg) {
  if (!Messages.has(chatId)) Messages.set(chatId, []);
  const arr = Messages.get(chatId);
  if (arr.find(x => x.id === msg.id)) return; // avoid dup
  arr.unshift(msg); // newest first
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// ========== Webhook from Z-API ==========
app.post("/webhook/zapi", async (req, res) => {
  try {
    const e = req.body;
    // Expecting { type: "message", message: {...} } but providers vary.
    if (e?.type !== "message" || !e.message) {
      return res.json({ ok: true });
    }
    const m = e.message;
    const chatId = m.chatId;              // e.g., "5598987654321@c.us"
    if (!chatId) return res.json({ ok: true });
    const phone = chatId.split("@")[0];
    const name = m.senderName || phone;
    const ts = (Number(m.timestamp) * 1000) || Date.now();
    const type = m.type;                  // "chat","image","document","audio","sticker",...
    const text = m.body || "";
    const mediaUrl = m.mediaUrl || null;
    const avatarUrl = m.senderProfilePicUrl || null; // optional; may be missing

    // Build preview text
    const previewText = (type === "chat")
      ? (text || "").slice(0, 120)
      : `[${type}] ${(text || "").slice(0, 80)}`;

    upsertChat({
      chatId, name, phone, ts, avatarUrl,
      preview: { type, text: previewText }
    });

    pushMessage(chatId, {
      id: m.id,
      chatId,
      fromMe: !!m.fromMe,
      type,
      text,
      mediaUrl,
      ts
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.json({ ok: true });
  }
});

// ========== Backfill historical messages ==========
// Call once after connection: POST /backfill  (with Authorization: Bearer AUTH_TOKEN)
app.post("/backfill", requireAuth, async (req, res) => {
  try {
    if (!ZAPI_BASE || !ZAPI_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing ZAPI_BASE or ZAPI_TOKEN env var." });
    }
    // 1) fetch chats
    const chatsResp = await fetch(`${ZAPI_BASE}/chats?token=${ZAPI_TOKEN}`);
    const chats = await chatsResp.json();

    for (const c of chats || []) {
      const chatId = c.id;
      if (!chatId) continue;
      const phone = chatId.split("@")[0];
      upsertChat({
        chatId,
        name: c.name || phone,
        phone,
        ts: Date.now(),
        avatarUrl: c.profilePicUrl || null
      });

      // 2) paginate messages
      let cursor = null;
      do {
        const url = `${ZAPI_BASE}/messages?token=${ZAPI_TOKEN}&chatId=${encodeURIComponent(chatId)}&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
        const pageResp = await fetch(url);
        const page = await pageResp.json();

        for (const m of page?.messages || []) {
          const msg = {
            id: m.id,
            chatId,
            fromMe: !!m.fromMe,
            type: m.type,
            text: m.body || "",
            mediaUrl: m.mediaUrl || null,
            ts: (Number(m.timestamp) * 1000) || Date.now()
          };
          pushMessage(chatId, msg);
          const prevTxt = (msg.type === "chat") ? (msg.text || "").slice(0, 120) : `[${msg.type}] ${(msg.text || "").slice(0, 80)}`;
          upsertChat({
            chatId,
            name: c.name || phone,
            phone,
            ts: msg.ts,
            preview: { type: msg.type, text: prevTxt }
          });
        }

        cursor = page?.nextCursor || null;
      } while (cursor);
    }

    res.json({ ok: true, chats: Chats.size });
  } catch (e) {
    console.error("Backfill error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ========== Threads for the app ==========
app.get("/threads", (req, res) => {
  const out = [...Chats.values()]
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    .map(c => {
      const phone = c.phone || (c.chatId?.split("@")[0] ?? "");
      // Avatar: if we don't have one, use Z-API profile-pic endpoint
      let avatar = { type: "none" };
      if (c.avatarUrl) {
        avatar = { type: "proxy", url: c.avatarUrl };
      } else if (phone && ZAPI_BASE && ZAPI_TOKEN) {
        const pic = `${ZAPI_BASE}/profile-pic?token=${ZAPI_TOKEN}&phone=${phone}`;
        avatar = { type: "proxy", url: pic };
      }
      return {
        chatId: c.chatId,
        name: c.name,
        phone,
        lastTs: c.lastTs,
        unread: 0,
        preview: c.preview || { type: "chat", text: "" },
        avatar
      };
    });
  res.json(out);
});

// ========== Messages for a chat (paged) ==========
app.get("/messages", (req, res) => {
  const { chatId, cursor = "0", pageSize = "50" } = req.query;
  const all = Messages.get(chatId) || [];
  const start = Number(cursor) || 0;
  const end = start + Number(pageSize);
  const slice = all.slice(start, end);
  const nextCursor = end < all.length ? String(end) : null;
  res.json({ items: slice, nextCursor });
});

// ========== Optional send (kept disabled by default) ==========
app.post("/send", requireAuth, async (req, res) => {
  try {
    if (READ_ONLY) {
      return res.status(403).json({ ok: false, error: "READ_ONLY mode is enabled." });
    }
    const { chatId, text } = req.body || {};
    if (!chatId || !text) return res.status(400).json({ ok: false, error: "chatId and text are required" });
    if (!ZAPI_BASE || !ZAPI_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing ZAPI_BASE or ZAPI_TOKEN" });
    }
    const url = `${ZAPI_BASE}/send-message?token=${ZAPI_TOKEN}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message: text })
    });
    const data = await r.json();
    res.json({ ok: true, zapi: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ========== Media proxy (to render images/avatars in mobile) ==========
app.get("/media", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send("missing url");
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).send("bad gateway");
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    // pipe the stream
    if (upstream.body && upstream.body.pipe) {
      upstream.body.pipe(res);
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    }
  } catch (e) {
    res.status(500).send("media error");
  }
});

// Export the app for Vercel serverless
export default app;

// Local dev (optional): only runs when not on Vercel
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("API on http://localhost:" + port));
}
