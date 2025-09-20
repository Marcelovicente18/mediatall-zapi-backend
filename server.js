// server.js — Backend CRM WhatsApp (Z-API) para Vercel (Node 18+ / ESM)

import express from "express";
import cors from "cors";

// --------- App base ----------
const app = express();
app.use(cors());

// aceita JSON e x-www-form-urlencoded (alguns provedores usam form)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// --------- ENV ----------
const ZAPI_BASE  = process.env.ZAPI_BASE || "";      // ex: https://api.z-api.io/instances/SEU_INSTANCE_ID
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";      // protege rotas /backfill e /send
const READ_ONLY  = process.env.READ_ONLY === "1";     // "1" => desabilita /send

// --------- Memória (ok p/ começar) ----------
const Chats = new Map();     // chatId -> { chatId, name, phone, lastTs, avatarUrl, preview }
const Messages = new Map();  // chatId -> [ { id, fromMe, type, text, mediaUrl, ts } ]
let LAST_HOOK = null;        // payload bruto do último webhook (debug)

function upsertChat({ chatId, name, phone, ts, avatarUrl, preview }) {
  const prev = Chats.get(chatId) || { chatId };
  Chats.set(chatId, {
    chatId,
    name: name || prev.name || phone || chatId,
    phone: phone || prev.phone || "",
    lastTs: Math.max(prev.lastTs || 0, ts || 0),
    avatarUrl: avatarUrl ?? prev.avatarUrl ?? null,
    preview: preview ?? prev.preview ?? null,
  });
}

function pushMessage(chatId, msg) {
  if (!Messages.has(chatId)) Messages.set(chatId, []);
  const arr = Messages.get(chatId);
  // idempotência
  if (arr.find(x => x.id === msg.id)) return;
  arr.unshift(msg); // mais novas primeiro
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// --------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

// --------- Normalizador de payloads ----------
function normalizeIncoming(b) {function normalizeIncoming(b) {
  if (!b) return [];
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch {}
  }

  // formatos comuns
  if (b.type === "message" && b.message) return [b.message];
  if (Array.isArray(b.messages)) return b.messages;
  if (b.event === "message" && b.data) return Array.isArray(b.data) ? b.data : [b.data];
  if (b.chatId && (b.body || b.text || b.caption || b.imageUrl || b.documentUrl)) return [b];
  if (b.msg && (b.msg.chatId || b.msg.from)) return [b.msg];

  // callbacks da Z-API (phone + text.message)
  if (b.type === "ReceivedCallback" || b.phone || (b.text && typeof b.text === "object")) {
    return [b];
  }

  // varredura recursiva: acha objetos com id + conteúdo
  const out = [];
  (function walk(x) {
    if (!x || typeof x !== "object") return;
    const hasId =
      x.chatId || x.from || x.jid || x.remoteJid || x.phone;
    const hasContent =
      x.body ||
      typeof x.text === "string" ||
      (x.text && typeof x.text === "object" && (x.text.message || x.text.caption)) ||
      x.caption ||
      x.imageUrl ||
      x.documentUrl;
    if (hasId && hasContent) out.push(x);
    for (const k of Object.keys(x)) walk(x[k]);
  })(b);

  return out;
}

// --------- Webhook robusto (aceita GET/POST, com/sem / no fim) ----------
app.all(/^\/webhook\/zapi\/?$/, (req, res) => {
  try {
    // guarda último payload bruto p/ debug
    LAST_HOOK = {
      method: req.method,
      headers: req.headers,
      query: req.query || {},
      body: (typeof req.body === "string" ? req.body : (req.body || null)),
    };

    // corpo possivelmente em string (form) -> tenta parse
    let body = LAST_HOOK.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {}
    }

    const incoming = normalizeIncoming(body || {});
    for (const m of incoming) {for (const m of incoming) {
  // chatId: usa chatId/from/jid… ou deriva do phone
  let chatId =
    m.chatId || m.from || m.jid || m.remoteJid ||
    (m.phone ? `${String(m.phone).replace(/\D/g, "")}@c.us` : null);
  if (!chatId) continue;

  const phone = (typeof chatId === "string" ? chatId.split("@")[0] : "") || (m.phone || "");

  // nome e avatar
  const name  = m.senderName || m.chatName || m.name || phone;
  const avatarUrl = m.senderPhoto || m.photo || m.profilePicUrl || m.avatarUrl || null;

  // timestamp
  const ts =
    (m.moment && Number(m.moment)) ||
    (m.timestamp && Number(m.timestamp) * 1000) ||
    Date.now();

  // tipo + texto
  let type =
    m.type === "ReceivedCallback" ? "chat" :
    m.messageType || m.type || (m.imageUrl ? "image" : "chat");

  let text =
    m.body ||
    (typeof m.text === "string" ? m.text : (m.text?.message || m.text?.caption || "")) ||
    m.caption || "";

  const mediaUrl = m.mediaUrl || m.imageUrl || m.documentUrl || null;

  const previewText =
    type === "chat" ? (text || "").slice(0, 120) : `[${type}] ${(text || "").slice(0, 80)}`;

  upsertChat({ chatId, name, phone, ts, avatarUrl, preview: { type, text: previewText } });

  const id = m.id || m.messageId || m.key?.id || `${chatId}-${ts}`;
  pushMessage(chatId, { id, chatId, fromMe: !!m.fromMe, type, text, mediaUrl, ts });
  }
});

// --------- Debug: ver último payload recebido ----------
app.get("/debug-last", (req, res) => {
  res.json(LAST_HOOK || { info: "nenhum webhook ainda" });
});

// --------- Threads (lista de conversas) ----------
app.get("/threads", (req, res) => {
  const out = [...Chats.values()]
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    .map(c => {
      const phone = c.phone || (c.chatId?.split("@")[0] ?? "");
      let avatar = { type: "none" };
      if (c.avatarUrl) {
        avatar = { type: "proxy", url: c.avatarUrl };
      } else if (phone && ZAPI_BASE && ZAPI_TOKEN) {
        // tenta foto via Z-API (alguns planos expõem esse endpoint)
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
        avatar,
      };
    });
  res.json(out);
});

// --------- Messages (histórico paginado) ----------
app.get("/messages", (req, res) => {
  const { chatId, cursor = "0", pageSize = "50" } = req.query;
  const all = Messages.get(chatId) || [];
  const start = Number(cursor) || 0;
  const end = start + Number(pageSize);
  const slice = all.slice(start, end);
  const nextCursor = end < all.length ? String(end) : null;
  res.json({ items: slice, nextCursor });
});

// --------- Media proxy (imagens/avatares) ----------
app.get("/media", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send("missing url");
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).send("bad gateway");
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.status(500).send("media error");
  }
});

// --------- Helpers Z-API (para backfill) ----------
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
  if (!ZAPI_BASE || !ZAPI_TOKEN) return [];
  const token = `token=${ZAPI_TOKEN}`;
  const endpoints = [
    `${ZAPI_BASE}/chats?${token}`,
    `${ZAPI_BASE}/client/chats?${token}`,
    `${ZAPI_BASE}/contacts?${token}`,
  ];
  for (const url of endpoints) {
    try {
      const data = await zGetJson(url);
      const arr = Array.isArray(data) ? data : (data.chats || data.contacts || data.items || []);
      if (Array.isArray(arr)) return arr;
    } catch {/* tenta o próximo */}
  }
  return [];
}

async function fetchMessagesForChat(chatId, limit = 200, cursor = null) {
  if (!ZAPI_BASE || !ZAPI_TOKEN) return { messages: [], nextCursor: null };
  const token = `token=${ZAPI_TOKEN}`;
  const qs = `${token}&chatId=${encodeURIComponent(chatId)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const endpoints = [
    `${ZAPI_BASE}/messages?${qs}`,
    `${ZAPI_BASE}/client/messages?${qs}`,
  ];
  for (const url of endpoints) {
    try {
      const data = await zGetJson(url);
      const messages = Array.isArray(data) ? data : (data.messages || data.items || []);
      const nextCursor = data.nextCursor || null;
      return { messages, nextCursor };
    } catch {/* tenta o próximo */}
  }
  return { messages: [], nextCursor: null };
}

// --------- Backfill (puxa histórico) ----------
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

// --------- Export para Vercel ---------
export default app;

// Dev local (opcional)
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("API on http://localhost:" + port));
}

