import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface InvoiceItem {
  date: string;
  vendorName: string;
  invoiceNumber: string;
  quantity: number | string;
  unitOfMeasure: string;
  itemDetail: string;
  unitPriceWithoutVat: number | string;
  totalPriceWithoutVat: number | string;
}

export interface GeminiResponse {
  reasoning: string;
  items: InvoiceItem[];
}

export async function processInvoices(base64Images: string[]): Promise<GeminiResponse> {
  const model = "gemini-3-flash-preview"; 

  const prompt = `
    Analyze the provided invoice image(s). 
    
    STEP 1: Reasoning
    Provide a step-by-step reasoning of how you identify the vendor, date, invoice number, and how you calculate the prices without VAT (IVA). 
    If the invoice shows VAT, you MUST subtract it to get the net price. If the tax rate is not clear, assume 21% for calculation but mention it in reasoning.
    
    STEP 2: Data Extraction
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

  const contents = {
    parts: [
      { text: prompt },
      ...base64Images.map(data => ({
        inlineData: {
          mimeType: "image/jpeg",
          data: data.split(',')[1] || data
        }
      }))
    ]
  };

  const response = await ai.models.generateContent({
    model,
    contents,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          reasoning: { type: Type.STRING },
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
        required: ["reasoning", "items"]
      }
    }
  });

  return JSON.parse(response.text);
}
