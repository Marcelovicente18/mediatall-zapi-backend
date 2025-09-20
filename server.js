import express from "express";

const app = express();
app.use(express.json());

// rota health — só para confirmar que funciona
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

export default app;

// local dev (não roda na Vercel, só no seu PC)
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("API rodando em http://localhost:" + port));
}
