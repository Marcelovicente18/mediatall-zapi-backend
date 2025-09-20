
# Mediatall Z-API Backend (Vercel)

Endpoints:
- `POST /webhook/zapi` — recebe eventos da Z-API.
- `POST /backfill` — puxa histórico (chame 1x) — exige `Authorization: Bearer AUTH_TOKEN` se definido.
- `GET /threads` — lista conversas com foto (avatar) e prévia (preview).
- `GET /messages?chatId=...&cursor=0&pageSize=50` — mensagens paginadas.
- `GET /media?url=...` — proxy de mídia/avatares (use sempre no app).
- `GET /health` — verificação simples.

## Variáveis de ambiente (na Vercel)
- `ZAPI_BASE` — ex: `https://api.z-api.io/instances/SEU_INSTANCE_ID`
- `ZAPI_TOKEN` — seu token
- `AUTH_TOKEN` — opcional, protege rotas administrativas
- `READ_ONLY` — defina `1` para desabilitar `/send`

## Testes rápidos
- `GET /health` → `{ ok: true }`
- `POST /backfill` com header `Authorization: Bearer AUTH_TOKEN`
- `GET /threads` → deve listar `avatar.url` e `preview.text`
- `GET /messages?chatId=...` → histórico do chat

## Observações
- Este backend usa armazenamento em memória (volátil) para simplificar.
- Para persistência, conecte a um banco (ex.: Supabase Postgres).
