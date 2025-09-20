for (const m of incoming) {
  // 1) detectar tipo "cru" que vem da Z-API
  const rawType = String(m.type || m.messageType || "").trim();

  // 2) ignorar eventos que não são conteúdo de mensagem
  if (
    /StatusCallback/i.test(rawType) ||     // MessageStatusCallback, etc.
    /Presence/i.test(rawType) ||
    /Typing/i.test(rawType) ||
    /Ack/i.test(rawType) ||
    /Read/i.test(rawType) ||
    /Delivered/i.test(rawType)
  ) {
    continue; // não cria/atualiza thread nem mensagem
  }

  // 3) montar chatId (usa chatId/from/... ou deriva do phone)
  let chatId =
    m.chatId || m.from || m.jid || m.remoteJid ||
    (m.phone ? `${String(m.phone).replace(/\D/g, "")}@c.us` : null);
  if (!chatId) continue;

  const phone = (typeof chatId === "string" ? chatId.split("@")[0] : "") || (m.phone || "");

  // 4) nome/avatar
  const name  = m.senderName || m.chatName || m.name || phone;
  const avatarUrl = m.senderPhoto || m.photo || m.profilePicUrl || m.avatarUrl || null;

  // 5) timestamp
  const ts =
    (m.moment && Number(m.moment)) ||
    (m.timestamp && Number(m.timestamp) * 1000) ||
    Date.now();

  // 6) tipo + texto
  let type =
    rawType === "ReceivedCallback" ? "chat" :
    m.messageType || rawType || (m.imageUrl ? "image" : "chat");

  let text =
    m.body ||
    (typeof m.text === "string" ? m.text : (m.text?.message || m.text?.caption || "")) ||
    m.caption || "";

  const mediaUrl = m.mediaUrl || m.imageUrl || m.documentUrl || null;

  // 7) montar prévia e atualizar chat
  const previewText = text || (mediaUrl ? `[${type}]` : "");

  upsertChat({
    chatId,
    name,
    phone,
    ts,
    avatarUrl,
    preview: { type, text: previewText }
  });

  // 8) salvar mensagem
  pushMessage(chatId, {
    id: m.id || String(Date.now()),
    fromMe: !!m.fromMe,
    type,
    text,
    mediaUrl,
    ts,
  });
}


