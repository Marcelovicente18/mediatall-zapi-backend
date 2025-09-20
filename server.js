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
  if (!Me
