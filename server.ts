import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware to parse JSON bodies from webhooks
  app.use(express.json());

  // ==========================================
  // API Routes (must be before Vite middleware)
  // ==========================================
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // I'mweb Webhook Receiver Endpoint
  app.post("/api/webhook/imweb", (req, res) => {
    console.log("=== I'mweb Webhook Received ===");
    const payload = req.body;
    
    // Log the incoming payload
    console.log(JSON.stringify(payload, null, 2));
    
    // TODO: Handle specific events here, for example:
    // if (payload.action === 'order.payment') { ... }
    
    // Always return a 200 OK fast so I'mweb knows the webhook was received
    res.status(200).json({ success: true, message: "Webhook received successfully" });
  });

  // ==========================================
  // Vite Middleware for Frontend Serving
  // ==========================================
  if (process.env.NODE_ENV !== "production") {
    // Development mode: Use Vite's middleware
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production mode: Serve static files from 'dist'
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook endpoint ready at: http://localhost:${PORT}/api/webhook/imweb`);
  });
}

startServer();
