// ====== WEBHOOK: mensagens novas da Z-API (aceita vários formatos) ======
function normalizeIncoming(body) {
  // Retorna SEMPRE um array de mensagens "m"
  if (!body) return [];

  // Caso 1: { type:"message", message:{...} }
  if (body.type === "message" && body.message) return [body.message];

  // Caso 2: { messages:[...] }
  if (Array.isArray(body.messages)) return body.messages;

  // Caso 3: { event:"message", data:{...} } ou { event:"message", data:[...] }
  if (body.event === "message" && body.data) {
    return Array.isArray(body.data) ? body.data : [body.data];
  }

  // Caso 4: payload direto de mensagem (tem chatId/body/etc.)
  if (body.chatId && (body.body || body.text || body.caption)) return [body];

  // Caso 5: alguns provedores mandam { msg:{...} }
  if (body.msg && (body.msg.chatId || body.msg.from)) return [body.msg];

  // Default: nada reconhecido
  return [];
}

app.post("/webhook/zapi", async (req, res) => {
  try {
    const incoming = normalizeIncoming(req.body);

    if (!incoming.length) {
      // debug leve (aparece nos Runtime Logs da Vercel)
      console.log("Webhook ignorado - formato não reconhecido. Keys:", Object.keys(req.body || {}));
      return res.json({ ok: true, ignored: true });
    }

    for (const m of incoming) {
      const chatId   = m.chatId || m.from || m.jid;
      if (!chatId) continue;

      const phone    = (typeof chatId === "string" ? chatId.split("@")[0] : "") || "";
      const name     = m.senderName || m.pushname || phone;
      const ts       = (Number(m.timestamp || m.t) * 1000) || Date.now();
      const type     = m.type || m.messageType || (m.imageUrl ? "image" : "chat");
      const text     = m.body || m.text || m.caption || "";
      const mediaUrl = m.mediaUrl || m.imageUrl || m.documentUrl || null;
      const avatarUrl= m.senderProfilePicUrl || m.profilePicUrl || null;

      const previewText = (type === "chat")
        ? (text || "").slice(0, 120)
        : `[${type}] ${(text || "").slice(0, 80)}`;

      upsertChat({
        chatId, name, phone, ts, avatarUrl,
        preview: { type, text: previewText }
      });

      const id = m.id || m.key?.id || `${chatId}-${ts}`;
      pushMessage(chatId, { id, chatId, fromMe: !!m.fromMe, type, text, mediaUrl, ts });
    }

    res.json({ ok: true, count: incoming.length });
  } catch (err) {
    console.error("Webhook error:", err);
    res.json({ ok: true });
  }
});
