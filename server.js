import express from "express";

const app = express();
app.use(express.json());

// sanity check endpoints
app.get("/health", (req, res) => res.json({ ok: true }));

app.all(/^\/webhook\/zapi\/?$/, (req, res) => {
  console.log("webhook hit", typeof req.body, req.body && Object.keys(req.body || {}));
  res.json({ ok: true });
});

app.get("/threads", (req, res) => res.json([]));

export default app;

if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("API on http://localhost:" + port));
}


