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
const DRIVE_API_KEY = process.env.DRIVE_API_KEY || "secret_key_123"; // Simple key for script auth

app.use(express.json({ limit: '50mb' }));

// Google OAuth Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.APP_URL}/auth/callback`
);

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

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
    const auth = new google.auth.OAuth2();
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
    const googleError = error.response?.data?.error?.message || error.message;
    res.status(500).json({ 
      error: googleError,
      details: error.response?.data?.error || null
    });
  }
});

// New endpoint for Google Apps Script integration
app.post("/api/drive/process", async (req, res) => {
  const { apiKey, base64Image, fileName } = req.body;

  // 1. Basic Auth
  if (apiKey !== DRIVE_API_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }

  if (!base64Image) {
    return res.status(400).json({ error: "Falta la imagen" });
  }

  try {
    const model = "gemini-3-flash-preview";
    const prompt = `
      Analyze the provided invoice image. 
      Extract every line item from the invoice into a structured list.
      
      Fields to extract for each item:
      - date: The date of the invoice (YYYY-MM-DD).
      - vendorName: The legal name of the provider.
      - invoiceNumber: The unique identifier of the invoice.
      - quantity: The numeric quantity of the item.
      - unitOfMeasure: e.g., 'unidades', 'kg', 'litros'. Use 'No disponible' if not found.
      - itemDetail: Full description of the product or service.
      - unitPriceWithoutVat: The price per unit EXCLUDING VAT.
      - totalPriceWithoutVat: The total price for this line item EXCLUDING VAT.
      
      If any field is missing, use "No disponible".
      Ensure mathematical consistency: quantity * unitPriceWithoutVat should equal totalPriceWithoutVat.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Image
            }
          }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  date: { type: Type.STRING },
                  vendorName: { type: Type.STRING },
                  invoiceNumber: { type: Type.STRING },
                  quantity: { type: Type.STRING },
                  unitOfMeasure: { type: Type.STRING },
                  itemDetail: { type: Type.STRING },
                  unitPriceWithoutVat: { type: Type.STRING },
                  totalPriceWithoutVat: { type: Type.STRING },
                },
                required: ["date", "vendorName", "invoiceNumber", "quantity", "unitOfMeasure", "itemDetail", "unitPriceWithoutVat", "totalPriceWithoutVat"]
              }
            }
          },
          required: ["items"]
        }
      }
    });

    const result = JSON.parse(response.text);
    res.json(result);
  } catch (error: any) {
    console.error("Drive Processing Error:", error);
    res.status(500).json({ error: error.message });
  }
});

async function startServer() {
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
