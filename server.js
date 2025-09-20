// server.js — Backend CRM WhatsApp (Z-API) para Vercel (Node 18+ / ESM)

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ===== ENV =====
const ZAPI_BASE  = process.env.ZAPI_BASE || "";  // opcional (para avatar via Z-API)
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || ""; // opcional (para avatar via Z-API)
const AUTH_TOKEN = process.env.AUTH_TOKEN || ""; // opcional (para rotas protegidas)
const READ_ONLY  = process.env.READ_ONLY === "1"; // reservado para futuro

// ===== Memória (só nesta execução) =====
const Chats = new Map();     // chatId -> { chatId, name, phone, lastTs, avatarUrl, preview }
const Messages = new Map();  // chatId -> [ { id, chatId, fromMe, type, text, mediaUrl, ts } ]
let LAST_HOOK = null;        // último payload bruto (debug)

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
  if (arr.find(x => x.id === msg.id)) return; // idempotência
  arr.unshift(msg); // mais novas primeiro
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// ===== Health =====
app.get("/health", (req, res) => res.json({ ok: true }));

// ===== Normalizador =====
function normalizeIncoming(b) {
  if (!b) return [];
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch {}
  }

  // formatos comuns
  if (b.type === "message" && b.message) return [b.message];
  if (Array.isArray(b.messages)) return b.messages;
  if (b.event === "message" && b.data) return Array.isArray(b.data) ? b.data : [b.data];

  // registro simples (um único objeto com conteúdo)
  if (b.chatId && (b.body || b.text || b.caption || b.imageUrl || b.documentUrl)) return [b];
  if (b.msg && (b.msg.chatId || b.msg.from)) return [b.msg];

  // callbacks Z-API mais comuns
  if (b.type === "ReceivedCallback" || b.phone || (b.text && typeof b.text === "object")) {
    return [b];
  }

  // varredura recursiva
  const out = [];
  (function walk(x) {
    if (!x || typeof x !== "object") return;
    const hasId = x.chatId || x.from || x.jid || x.remoteJid || x.phone;
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

// ===== Webhook (aceita GET/POST, com/sem barra) =====
app.all(/^\/webhook\/zapi\/?$/, (req, res) => {
  try {
    // guarda último payload para debug
    LAST_HOOK = {
      method: req.method,
      headers: req.headers,
      query: req.query || {},
      body: (typeof req.body === "string" ? req.body : (req.body || null)),
    };

    // se vier como string (form), tenta parsear
    let body = LAST_HOOK.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {}
    }

    const incoming = normalizeIncoming(body || {});

    for (const m of incoming) {
      // tipo "cru" (Z-API costuma mandar ReceivedCallback / MessageStatusCallback ...)
      const rawType = String(m.type || m.messageType || "").trim();

      // Ignorar SOMENTE eventos que nunca carregam conteúdo de usuário
      if (/MessageStatusCallback|Presence|Typing/i.test(rawType)) {
        continue;
      }

      // chatId (usa chatId/from/... ou deriva do phone)
      let chatId =
        m.chatId || m.from || m.jid || m.remoteJid ||
        (m.phone ? `${String(m.phone).replace(/\D/g, "")}@c.us` : null);
      if (!chatId) continue;

      const phone = (typeof chatId === "string" ? chatId.split("@")[0] : "") || (m.phone || "");

      // nome / avatar
      const name  = m.senderName || m.chatName || m.name || phone;
      const avatarUrl = m.senderPhoto || m.photo || m.profilePicUrl || m.avatarUrl || null;

      // timestamp
      const ts =
        (m.moment && Number(m.moment)) ||
        (m.timestamp && Number(m.timestamp) * 1000) ||
        Date.now();

      // tipo + texto
      let type =
        rawType === "ReceivedCallback" ? "chat" :
        m.messageType || rawType || (m.imageUrl ? "image" : "chat");

      let text =
        m.body ||
        (typeof m.text === "string" ? m.text : (m.text?.message || m.text?.caption || "")) ||
        m.caption || "";

      const mediaUrl = m.mediaUrl || m.imageUrl || m.documentUrl || null;

      // preview + upsert chat
      const previewText = text || (mediaUrl ? `[${type}]` : "");
      upsertChat({
        chatId,
        name,
        phone,
        ts,
        avatarUrl,
        preview: { type, text: previewText }
      });

      // salva mensagem
      const id = m.id || m.messageId || m.key?.id || `${chatId}-${ts}`;
      pushMessage(chatId, { id, chatId, fromMe: !!m.fromMe, type, text, mediaUrl, ts });
    }

    // resposta
    const payload = { ok: true, received: Array.isArray(incoming) ? incoming.length : 0 };

    // se chamar com ?echo=1, devolve threads + mensagens + debug desta execução
    if (String(req.query.echo || "") === "1") {
      payload.threads = [...Chats.values()];
      payload.messages = Object.fromEntries(
        [...Messages.entries()].map(([k, v]) => [k, v.slice(0, 5)])
      );
      // DEBUG extra para entendermos o que foi interpretado e salvo
      payload.debug = {
        incomingRawType: incoming.map(m => m?.type || m?.messageType || null),
        chatsKeys: [...Chats.keys()],
        messagesKeys: [...Messages.keys()],
      };
    }

    res.json(payload);
  } catch (e) {
    console.error("Webhook error:", e);
    res.json({ ok: true, handled: false });
  }
});

// ===== Debug do último payload =====
app.get("/debug-last", (req, res) => {
  res.json(LAST_HOOK || { info: "nenhum webhook ainda" });
});

// ===== Threads (snapshot desta execução) =====
app.get("/threads", (req, res) => {
  const out = [...Chats.values()]
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
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
        preview: c.preview || { type: "chat", text: "" },
        avatar,
      };
    });
  res.json(out);
});

// ===== Messages (snapshot desta execução; paginado) =====
app.get("/messages", (req, res) => {
  const { chatId, cursor = "0", pageSize = "50" } = req.query;
  const all = Messages.get(chatId) || [];
  const start = Number(cursor) || 0;
  const end = start + Number(pageSize);
  const slice = all.slice(start, end);
  const nextCursor = end < all.length ? String(end) : null;
  res.json({ items: slice, nextCursor });
});

// ===== Media proxy =====
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

// ===== Export (Vercel) =====
export default app;

// Dev local (opcional)
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("API on http://localhost:" + port));
}

