import express from "express";

const app = express();
app.use(express.json());

// rota health — só para confirmar que funciona
app.get("/health", (req, res) => {
  res.json({ ok: true });
});
// === ENV ===
const ZAPI_BASE  = process.env.ZAPI_BASE || "";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const READ_ONLY  = process.env.READ_ONLY === "1";

// === Memória (ok p/ começar) ===
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
    preview: preview ?? prev.preview ?? null,
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

// === Threads (lista de conversas) ===
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

// === Messages (histórico paginado) ===
app.get("/messages", (req, res) => {
  const { chatId, cursor = "0", pageSize = "50" } = req.query;
  const all = Messages.get(chatId) || [];
  const start = Number(cursor) || 0;
  const end = start + Number(pageSize);
  const slice = all.slice(start, end);
  const nextCursor = end < all.length ? String(end) : null;
  res.json({ items: slice, nextCursor });
});
// === Webhook robusto (aceita formatos diferentes) ===
function normalizeIncoming(b) {
  if (!b) return [];
  if (b.type === "message" && b.message) return [b.message];
  if (Array.isArray(b.messages)) return b.messages;
  if (b.event === "message" && b.data) return Array.isArray(b.data) ? b.data : [b.data];
  if (b.chatId && (b.body || b.text || b.caption)) return [b];
  if (b.msg && (b.msg.chatId || b.msg.from)) return [b.msg];
  return [];
}

app.post("/webhook/zapi", async (req, res) => {
  try {
    const incoming = normalizeIncoming(req.body || {});
    if (!incoming.length) return res.json({ ok: true, ignored: true });

    for (const m of incoming) {
      const chatId = m.chatId || m.from || m.jid;
      if (!chatId) continue;

      const phone    = (typeof chatId === "string" ? chatId.split("@")[0] : "") || "";
      const name     = m.senderName || m.pushname || phone;
      const ts       = (Number(m.timestamp || m.t) * 1000) || Date.now();
      const type     = m.type || m.messageType || (m.imageUrl ? "image" : "chat");
      const text     = m.body || m.text || m.caption || "";
      const mediaUrl = m.mediaUrl || m.imageUrl || m.documentUrl || null;
      const avatarUrl= m.senderProfilePicUrl || m.profilePicUrl || null;

      const previewText = (type === "chat")
        ? (text || "").slice(0,120)
        : `[${type}] ${(text || "").slice(0,80)}`;

      upsertChat({ chatId, name, phone, ts, avatarUrl, preview: { type, text: previewText } });

      const id = m.id || m.key?.id || `${chatId}-${ts}`;
      pushMessage(chatId, { id, chatId, fromMe: !!m.fromMe, type, text, mediaUrl, ts });
    }
    res.json({ ok: true, count: incoming.length });
  } catch (e) {
    console.error("Webhook error:", e);
    res.json({ ok: true });
  }
});

// === Proxy de mídia/avatares ===
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
// rota para receber webhooks da Z-API
app.post("/webhook/zapi", (req, res) => {
  console.log("Webhook recebido:", req.body);  // log no Vercel
  res.json({ ok: true });

  // exemplo: salvar em memória (só teste)
  global.lastMessage = req.body;
});

// rota debug para ver última mensagem recebida
app.get("/debug-last", (req, res) => {
  res.json(global.lastMessage || { info: "nenhum webhook ainda" });
});

export default app;

// local dev (não roda na Vercel, só no seu PC)
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("API rodando em http://localhost:" + port));
}
