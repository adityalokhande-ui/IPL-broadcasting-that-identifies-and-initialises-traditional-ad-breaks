import express from "express";
import http from "http";
import path from "path";
import dns from "dns";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

import { db } from "./src/database.js";
import { getInterpolatedFrame } from "./src/utils/aiSimulatorData.js";

// Load environment variables
dotenv.config();

// Ensure local DNS resolution doesn't crash on Node 18+ inside sands
dns.setDefaultResultOrder && dns.setDefaultResultOrder("ipv4first");

const app = express();
app.use(express.json());

const PORT = 3000;

// Lazy initialize Gemini AI client to prevent crashes if key is omitted
let aiClient: GoogleGenAI | null = null;
function getGeminiAI(): GoogleGenAI | null {
  if (aiClient) return aiClient;
  const key = process.env.GEMINI_API_KEY;
  if (key && key !== "MY_GEMINI_API_KEY") {
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
    return aiClient;
  }
  return null;
}

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Products & Ad Catalog CRUD
app.get("/api/products", (req, res) => {
  try {
    res.json(db.getProducts());
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read products" });
  }
});

app.post("/api/products", (req, res) => {
  try {
    const { name, brand, category, logoUrl, targetSurface, slogan, campaignStatus } = req.body;
    if (!name || !brand || !targetSurface) {
      return res.status(400).json({ error: "Name, brand, and target surface are required" });
    }
    const newPrd = db.addProduct({
      name,
      brand,
      category: category || "General",
      logoUrl: logoUrl || "https://picsum.photos/seed/brand/100/100",
      targetSurface,
      slogan: slogan || `${brand} - Live IPL Champion`,
      campaignStatus: campaignStatus || "active",
    });
    res.status(201).json(newPrd);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to add product" });
  }
});

app.put("/api/products/:id", (req, res) => {
  try {
    const updated = db.updateProduct(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update product" });
  }
});

app.delete("/api/products/:id", (req, res) => {
  try {
    const success = db.deleteProduct(req.params.id);
    if (!success) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// Campaigns Management CRUD
app.get("/api/campaigns", (req, res) => {
  res.json(db.getCampaigns());
});

app.post("/api/campaigns", (req, res) => {
  const { name, productId, status, budget, bidAmount } = req.body;
  if (!name || !productId) {
    return res.status(400).json({ error: "Campaign name and product ID are required" });
  }
  const newCamp = db.addCampaign({
    name,
    productId,
    status: status || "active",
    budget: Number(budget) || 100000,
    bidAmount: Number(bidAmount) || 1.00,
  });
  res.status(201).json(newCamp);
});

app.put("/api/campaigns/:id", (req, res) => {
  const updated = db.updateCampaign(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Campaign not found" });
  res.json(updated);
});

app.delete("/api/campaigns/:id", (req, res) => {
  const success = db.deleteCampaign(req.params.id);
  if (!success) return res.status(404).json({ error: "Campaign not found" });
  res.json({ success: true });
});

// Detection Logs REST
app.get("/api/logs", (req, res) => {
  res.json(db.getLogs());
});

app.post("/api/logs/clear", (req, res) => {
  db.clearLogs();
  res.json({ success: true });
});

// AI Contextual Slogan Designer using Gemini
app.post("/api/ai/tagline", async (req, res) => {
  const { brandName, productName, targetSurface, matchesContext } = req.body;
  if (!brandName || !productName) {
    return res.status(400).json({ error: "Brand and product names are required" });
  }

  // Define backup fallback generators for offline / missing key stability
  const promptFallback = () => {
    const fallbacks = [
      `${brandName} ${productName}: Extreme grip on the ${targetSurface || "pitch"}!`,
      `Performance that shines bright, styled on every ${targetSurface || "boundary"}.`,
      `Live the IPL match spirit with the premium choice of champions: ${brandName}.`,
    ];
    return fallbacks;
  };

  try {
    const ai = getGeminiAI();
    if (!ai) {
      // Local fallback in case of missing keys
      console.log("Gemini API key not found, returning smart procedural fallbacks.");
      return res.json({
        slogans: promptFallback(),
        isMock: true,
        notice: "Using local AI-matching engine. Set a real key in Settings->Secrets to activate Live Gemini."
      });
    }

    const prompt = `Write 3 short, high-impact advertising slogans or slogans specifically crafted for live stadium banner placements during a cricket IPL match.
Brand Name: "${brandName}"
Product Description: "${productName}"
Target Position: "${targetSurface || "stadium surface"}"
Live match events detail: "${matchesContext || "cricket sixes, boundary action, batsman close up"}"

Output rules:
- Return ONLY a JSON array containing 3 string slogans. Do not add markdown backticks or commentary outside the JSON array of strings itself.
- High energy, sports-focused, punchy. Keep each slogan under 8 words.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const parsed = JSON.parse(response.text || "[]");
    return res.json({ slogans: Array.isArray(parsed) ? parsed : promptFallback(), isMock: false });
  } catch (err: any) {
    console.error("Gemini Slogan Generator error:", err);
    return res.json({ slogans: promptFallback(), isMock: true, error: err.message });
  }
});

// ==========================================
// FULL STACK AND WEBSOCKET INITIALIZATION
// ==========================================

async function startServer() {
  const server = http.createServer(app);

  // Initialize a real WebSocket server sharing the same port (3000)
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);
    if (pathname === "/api/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    console.log("WebSocket connection established with client");

    ws.on("message", (message: string) => {
      try {
        const payload = JSON.parse(message);
        
        if (payload.type === "sync_broadcast") {
          const videoTime = Number(payload.time) || 0;
          const confidenceThreshold = Number(payload.threshold) ?? 0.70;

          // Fetch the simulated detections for the current video second
          const rawFrame = getInterpolatedFrame(videoTime);
          const activeProducts = db.getProducts().filter(p => p.campaignStatus === "active");

          // For each raw surface detection, try to match an active campaign
          const annotatedDetections = rawFrame.detections.map((detection) => {
            if (detection.confidence < confidenceThreshold) {
              return detection; 
            }

            // Find an active brand targeting this surface
            const match = activeProducts.find(p => p.targetSurface === detection.surfaceType);
            if (match) {
              return {
                ...detection,
                suggestedAdBrand: match.brand,
                suggestedAdLogo: match.logoUrl,
                suggestedSlogan: match.slogan,
                productId: match.id,
              };
            }
            return detection;
          });

          // Feed updated frame telemetries back to client
          ws.send(JSON.stringify({
            type: "telemetry",
            timestamp: rawFrame.timestamp,
            sceneDescription: rawFrame.sceneDescription,
            cameraAngle: rawFrame.cameraAngle,
            detections: annotatedDetections,
          }));
        }

        // Triggered when client logs a placement impression or click
        if (payload.type === "ad_interaction") {
          const { productId, action, confidence, surfaceType } = payload;
          const product = db.getProduct(productId);
          if (product) {
            let incrementImpressions = 0;
            let incrementClicks = 0;
            let revenuePayout = 0;

            const basePayout = 1.50; // default RPC pricing

            if (action === "placed") {
              incrementImpressions = 1;
              revenuePayout = basePayout;
            } else if (action === "clicked") {
              incrementClicks = 1;
              revenuePayout = basePayout * 4; // premium click commission
            }

            db.updateProduct(productId, {
              impressions: product.impressions + incrementImpressions,
              clicks: product.clicks + incrementClicks,
              revenue: product.revenue + revenuePayout,
            });

            // Log event inside database
            const timeLabel = new Date().toLocaleTimeString("en-US", { hour12: false });
            const logEntry = db.addLog({
              timeLabel,
              surfaceType,
              adBrand: product.brand,
              action: action === "clicked" ? "clicked" : "placed",
              confidence,
              payout: revenuePayout,
            });

            // Broadcast log entry back to client
            ws.send(JSON.stringify({
              type: "log_pushed",
              log: logEntry,
            }));
          }
        }
      } catch (e) {
        console.error("Error processing websocket frame:", e);
      }
    });

    ws.on("close", () => {
      console.log("WebSocket connection closed");
    });
  });

  // Vite Integration for Serving UI Assets & Development Bundles
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Live full-stack system compiled server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
