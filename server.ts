import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { google } from "googleapis";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

app.use(express.json({ limit: '50mb' }));

const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

// Google OAuth Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${APP_URL}/auth/callback`
);

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly'
];

app.get("/api/config", (req, res) => {
  res.json({ 
    clientId: process.env.GOOGLE_CLIENT_ID,
    developerKey: process.env.GOOGLE_API_KEY || "" 
  });
});

app.get("/api/auth/url", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.json({ url });
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    // In a real app, we'd store this in a session/DB. 
    // For this demo, we'll send it back to the client to store in localStorage (less secure but works for demo)
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', tokens: ${JSON.stringify(tokens)} }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Autenticación exitosa. Esta ventana se cerrará automáticamente.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Error exchanging code:", error);
    res.status(500).send("Error en la autenticación");
  }
});

app.post("/api/sheets/append", async (req, res) => {
  const { tokens, spreadsheetId, values } = req.body;
  
  if (!tokens || !spreadsheetId || !values) {
    return res.status(400).json({ error: "Faltan parámetros" });
  }

  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${APP_URL}/auth/callback`
    );
    auth.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. Get spreadsheet metadata to find the first sheet's name
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });
    
    const firstSheetName = spreadsheet.data.sheets?.[0]?.properties?.title || 'Sheet1';

    // 2. Get existing data to check for duplicates
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${firstSheetName}!A:H`,
    });

    const existingRows = response.data.values || [];
    
    // Filter out duplicates
    // We check Vendor (B), Invoice # (C), and Detail (F)
    const newValues = values.filter((newRow: any[]) => {
      const isDuplicate = existingRows.some(existingRow => 
        existingRow[1] === newRow[1] && // Vendor
        existingRow[2] === newRow[2] && // Invoice #
        existingRow[5] === newRow[5]    // Detail
      );
      return !isDuplicate;
    });

    if (newValues.length === 0) {
      return res.json({ message: "No hay datos nuevos para agregar (duplicados detectados)", count: 0 });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${firstSheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: newValues,
      },
    });

    res.json({ message: "Datos guardados exitosamente", count: newValues.length });
  } catch (error: any) {
    console.error("Sheets API Error:", error);
    
    // Extract specific Google API error message if available
    const errorData = error.response?.data;
    const googleError = errorData?.error_description || 
                        errorData?.error?.message || 
                        errorData?.error || 
                        error.message;

    res.status(500).json({ 
      error: googleError,
      details: errorData || null
    });
  }
});

// Global error handler to prevent HTML responses for API routes
app.use((err: any, req: any, res: any, next: any) => {
  console.error("Global Error:", err);
  if (req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
    return res.status(err.status || 500).json({ 
      error: "Error en el servidor", 
      message: err.message,
      path: req.path
    });
  }
  next(err);
});

async function startServer() {
  // API 404 Handler - MUST be before Vite/Static
  app.use('/api', (req, res) => {
    console.warn(`[API 404] ${req.method} ${req.path}`);
    res.status(404).json({ 
      error: "API endpoint not found", 
      path: req.path,
      method: req.method 
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
