// server.js — Mediatall Z-API Backend (versão estável)

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ===== ENV =====
const ZAPI_BASE  = process.env.ZAPI_BASE;   // ex: https://api.z-api.io/instances/INSTANCE_ID
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;  // token da instância
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const READ_ONLY  = process.env.READ_ONLY === "1";

// ===== Memória (ok para começar) =====
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
  if (arr.find(x => x.id === msg.id)) return;
  arr.unshift(msg);
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// ===== Health =====
app.get("/health", (req, res) => res.json({ ok: true }));

// ===== Helpers Z-API (tentar variações comuns) =====
async function zGetJson(url) {
  const r = await fetch(url);
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) {
    const info = body ? JSON.stringify(body) : (await r.text().catch(()=>"(no body)"));
    throw new Error(`ZAPI ${r.status} ${info}`);
  }
  return body;
}

async function fetchAllChats() {
  const base = `${ZAPI_BASE}`;
  const token = `token=${ZAPI_TOKEN}`;
  const candidates = [
    `${base}/chats?${token}`,
    `${base}/client/chats?${token}`,
    `${base}/contacts?${token}`
  ];
  for (const url of candidates) {
    try {
      const data = await zGetJson(url);
      const arr = Array.isArray(data) ? data : (data.chats || data.contacts || data.items || []);
      if (Array.isArray(arr)) return arr;
    } catch (e) { /* tenta próximo */ }
  }
  return []; // ok retornar vazio
}

async function fetchMessagesForChat(chatId, limit = 200, cursor = null) {
  const base = `${ZAPI_BASE}`;
  const token = `token=${ZAPI_TOKEN}`;
  const qs = `${token}&chatId=${encodeURIComponent(chatId)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const candidates = [
    `${base}/messages?${qs}`,
    `${base}/client/messages?${qs}`
  ];
  for (const url of candidates) {
    try {
      const data = await zGetJson(url);
      const messages = Array.isArray(data) ? data : (data.messages || data.items || []);
      const nextCursor = data.nextCursor || null;
      return { messages, nextCursor };
    } catch (e) { /* tenta próximo */ }
  }
  return { messages: [], nextCursor: null };
}

// ===== Webhook robusto =====
app.post("/webhook/zapi", async (req, res) => {
  try {
    const b = req.body || {};
    // normaliza possíveis formatos
    let incoming = [];
    if (b.type === "message" && b.message) incoming = [b.message];
    else if (Array.isArray(b.messages)) incoming = b.messages;
    else if (b.event === "message" && b.data) incoming = Array.isArray(b.data) ? b.data : [b.data];
    else if (b.chatId && (b.body || b.text || b.caption)) incoming = [b];
    else if (b.msg && (b.msg.chatId || b.msg.from)) incoming = [b.msg];

    if (!incoming.length) return res.json({ ok: true, ignored: true });

    for (const m of incoming) {
      const chatId = m.chatId || m.from || m.jid;
      if (!chatId) continue;

      const phone = (typeof chatId === "string" ? chatId.split("@")[0] : "") || "";
      const name  = m.senderName || m.pushname || phone;
      const ts    = (Number(m.timestamp || m.t) * 1000) || Date.now();
      const type  = m.type || m.messageType || (m.imageUrl ? "image" : "chat");
      const text  = m.body || m.text || m.caption || "";
      const mediaUrl  = m.mediaUrl || m.imageUrl || m.documentUrl || null;
      const avatarUrl = m.senderProfilePicUrl || m.profilePicUrl || null;

      const previewText = (type === "chat") ? (text || "").slice(0, 120)
                                            : `[${type}] ${(text || "").slice(0, 80)}`;

      upsertChat({ chatId, name, phone, ts, avatarUrl, preview: { type, text: previewText } });

      const id = m.id || m.key?.id || `${chatId}-${ts}`;
      pushMessage(chatId, { id, chatId, fromMe: !!m.fromMe, type, text, mediaUrl, ts });
    }
    res.json({ ok: true, count: incoming.length });
  } catch (err) {
    console.error("Webhook error:", err);
    res.json({ ok: true, handled: false });
  }
});

// ===== Backfill (puxa histórico; ok retornar 0) =====
app.post("/backfill", requireAuth, async (req, res) => {
  try {
    if (!ZAPI_BASE || !ZAPI_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing ZAPI_BASE or ZAPI_TOKEN" });
    }
    const chats = await fetchAllChats(); // pode vir vazio em alguns planos
    for (const c of chats) {
      const chatId = c.id || c.chatId || c.jid;
      if (!chatId) continue;
      const phone = c.phone || (typeof chatId === "string" ? chatId.split("@")[0] : "");
      const name  = c.name || c.pushname || phone;
      const avatarUrl = c.profilePicUrl || c.avatarUrl || null;
      upsertChat({ chatId, name, phone, ts: Date.now(), avatarUrl });

      let cursor = null;
      do {
        const page = await fetchMessagesForChat(chatId, 200, cursor);
        for (const m of page.messages) {
          const id   = m.id || m.key?.id || `${chatId}-${m.timestamp || Date.now()}`;
          const type = m.type || m.messageType || (m.imageUrl ? "image" : "chat");
          const text = m.body || m.text || m.caption || "";
          const mediaUrl = m.mediaUrl || m.imageUrl || m.documentUrl || null;
          const ts   = (Number(m.timestamp || m.t) * 1000) || Date.now();
          pushMessage(chatId, { id, chatId, fromMe: !!m.fromMe, type, text, mediaUrl, ts });

          const previewText = (type === "chat") ? (text || "").slice(0,120) : `[${type}] ${(text || "").slice(0,80)}`;
          upsertChat({ chatId, name, phone, ts, preview: { type, text: previewText } });
        }
        cursor = page.nextCursor || null;
      } while (cursor);
    }
    res.json({ ok: true, chats: Chats.size });
  } catch (e) {
    console.error("Backfill error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== Threads =====
app.get("/threads", (req, res) => {
  const out = [...Chats.values()]
    .sort((a,b) => (b.lastTs||0) - (a.lastTs||0))
    .map(c => {
      const phone = c.phone || (c.chatId?.split("@")[0] ?? "");
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
        preview: c.preview || {

