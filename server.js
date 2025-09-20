
// server.js — Mediatall Z-API Backend (Vercel, Node 18+)

import express from "express";
import cors from "cors";

// Node 18+ já tem fetch global
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ====== ENV ======
// ZAPI_BASE: ex. https://api.z-api.io/instances/SEU_INSTANCE_ID
// ZAPI_TOKEN: token da sua instância
// AUTH_TOKEN: opcional, protege rotas administrativas
// READ_ONLY: defina "1" para desabilitar /send (somente leitura)
const ZAPI_BASE  = process.env.ZAPI_BASE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const READ_ONLY  = process.env.READ_ONLY === "1";

// ====== STORAGE EM MEMÓRIA (ok p/ começar) ======
const Chats    = new Map(); // chatId -> { chatId, name, phone, lastTs, avatarUrl, preview }
const Messages = new Map(); // chatId -> [ { id, fromMe, type, text, mediaUrl, ts } ]

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
  if (arr.find(x => x.id === msg.id)) return; // evita duplicar
  arr.unshift(msg); // mais novas primeiro
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// ====== HEALTH ======
app.get("/health", (req, res) => res.json({ ok: true }));

// ====== HELPERS ROBUSTOS (Z-API pode variar por plano/versão) ======
async function zGetJson(url) {
  const r = await fetch(url);
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) {
    const info = body ? JSON.stringify(body) : await r.text().catch(()=>"(no body)");
    throw new Error(`ZAPI GET ${url} -> ${r.status} ${info}`);
  }
  return body;
}

// Tenta múltiplos endpoints para listar chats e normaliza o formato
async function fetchAllChats() {
  const base  = `${ZAPI_BASE}`;
  const token = `token=${ZAPI_TOKEN}`;

  const candidates = [
    `${base}/chats?${token}`,
    `${base}/client/chats?${token}`,
    `${base}/contacts?${token}`
  ];

  for (const url of candidates) {
    try {
      const data = await zGetJson(url);
      // pode vir {chats:[...]} | {contacts:[...]} | {items:[...]} | [...]
      const arr = Array.isArray(data) ? data : (data.chats || data.contacts || data.items || []);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      // tenta próximo
    }
  }
  throw new Error("Não consegui listar chats: todos endpoints candidatos falharam.");
}

// Lista mensagens de um chat (paginado) aceitando formatos diferentes
async function fetchMessagesForChat(chatId, limit = 200, cursor = null) {
  const base  = `${ZAPI_BASE}`;
  const token = `token=${ZAPI_TOKEN}`;
  const qs = `${token}&chatId=${encodeURIComponent(chatId)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

  const candidates = [
    `${base}/messages?${qs}`,
    `${base}/client/messages?${qs}`
  ];

  for (const url of candidates) {
    try {
      const data = await zGetJson(url);
      // pode vir {messages:[...], nextCursor} | {items:[...]} | [...]
      const messages = Array.isArray(data) ? data : (data.messages || data.items || []);
      const nextCursor = data.nextCursor || null;
      return { messages, nextCursor };
    } catch (e) {
      // tenta próximo
    }
  }
  // se nada funcionar, retorna vazio sem quebrar
  return { messages: [], nextCursor: null };
}

// ====== WEBHOOK: mensagens novas da Z-API ======
app.post("/webhook/zapi", async (req, res) => {
  try {
    const e = req.body;
    if (e?.type !== "message" || !e.message) {
      return res.json({ ok: true });
    }
    const m = e.message;
    const chatId = m.chatId || m.from || m.jid; // cobre variações
    if (!chatId) return res.json({ ok: true });

    const phone = (typeof chatId === "string" ? chatId.split("@")[0] : "") || "";
    const name  = m.senderName || m.pushname || phone;
    const ts    = (Number(m.timestamp || m.t) * 1000) || Date.now();
    const type  = m.type || m.messageType || (m.imageUrl ? "image" : "chat");
    const text  = m.body || m.text || m.caption || "";
    const mediaUrl  = m.mediaUrl || m.imageUrl || m.documentUrl || null;
    const avatarUrl = m.senderProfilePicUrl || m.profilePicUrl || null;

    const previewText = (type === "chat") ? (text || "").slice(0,120)
                                          : `[${type}] ${(text || "").slice(0,80)}`;

    upsertChat({
      chatId, name, phone, ts, avatarUrl,
      preview: { type, text: previewText }
    });

    pushMessage(chatId, {
      id: m.id || m.key?.id,
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

// ====== BACKFILL: puxar histórico antigo (chame 1x) ======
app.post("/backfill", requireAuth, async (req, res) => {
  try {
    if (!ZAPI_BASE || !ZAPI_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing ZAPI_BASE or ZAPI_TOKEN env var." });
    }

    // 1) listar chats (tentando vários endpoints)
    const chats = await fetchAllChats();

    for (const c of chats) {
      const chatId = c.id || c.chatId || c.jid;
      if (!chatId) continue;

      const phone = (c.phone || (typeof chatId === "string" ? chatId.split("@")[0] : "")) || "";
      const name  = c.name || c.pushname || phone;
      const avatarUrl = c.profilePicUrl || c.avatarUrl || null;

      upsertChat({ chatId, name, phone, ts: Date.now(), avatarUrl });

      // 2) mensagens por chat (paginado)
      let cursor = null;
      do {
        const page = await fetchMessagesForChat(chatId, 200, cursor);
        for (const m of page.messages) {
          const id   = m.id || m.key?.id;
          if (!id) continue; // precisa de id p/ idempotência

          const type = m.type || m.messageType || (m.imageUrl ? "image" : "chat");
          const text = m.body || m.text || m.caption || "";
          const mediaUrl = m.mediaUrl || m.imageUrl || m.documentUrl || null;
          const ts   = (Number(m.timestamp || m.t) * 1000) || Date.now();

          pushMessage(chatId, { id, chatId, fromMe: !!m.fromMe, type, text, mediaUrl, ts });

          const previewText = (type === "chat") ? (text || "").slice(0,120)
                                                : `[${type}] ${(text || "").slice(0,80)}`;
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

// ====== THREADS ======
app.get("/threads", (req, res) => {
  const out = [...Chats.values()]
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    .map(c => {
      const phone = c.phone || (c.chatId?.split("@")[0] ?? "");
      // Avatar: se não houver, usa endpoint de foto da Z-API
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

// ====== MESSAGES ======
app.get("/messages", (req, res) => {
  const { chatId, cursor = "0", pageSize = "50" } = req.query;
  const all = Messages.get(chatId) || [];
  const start = Number(cursor) || 0;
  const end = start + Number(pageSize);
  const slice = all.slice(start, end);
  const nextCursor = end < all.length ? String(end) : null;
  res.json({ items: slice, nextCursor });
});

// ====== SEND (opcional; desabilitado se READ_ONLY=1) ======
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

// ====== MEDIA PROXY ======
app.get("/media", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send("missing url");
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).send("bad gateway");
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
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

// ====== EXPORT PARA VERCEL ======
export default app;

// Dev local (opcional)
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("API on http://localhost:" + port));
}
