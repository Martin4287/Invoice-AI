import React, { useState, useEffect, useCallback } from 'react';
import { 
  Upload, 
  FileText, 
  Loader2, 
  CheckCircle2, 
  AlertCircle, 
  Table as TableIcon, 
  Save, 
  Plus, 
  Trash2,
  ExternalLink,
  ChevronRight,
  Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { processInvoices, InvoiceItem, GeminiResponse } from './services/gemini';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const SPREADSHEET_ID = '1B-JXxiKxMrGZHEi3Wene4YwPrP5XApAbiHkBLDFRdaw';
const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<GeminiResponse | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [googleTokens, setGoogleTokens] = useState<any>(null);
  const [config, setConfig] = useState<{ clientId: string, developerKey: string } | null>(null);
  const [isDriveLoading, setIsDriveLoading] = useState(false);

  useEffect(() => {
    fetch('/api/config').then(res => res.json()).then(setConfig);
    
    const savedTokens = localStorage.getItem('google_tokens');
    if (savedTokens) {
      setGoogleTokens(JSON.parse(savedTokens));
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const tokens = event.data.tokens;
        setGoogleTokens(tokens);
        localStorage.setItem('google_tokens', JSON.stringify(tokens));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files);
      setFiles(prev => [...prev, ...newFiles]);
      
      newFiles.forEach(file => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setPreviews(prev => [...prev, reader.result as string]);
        };
        reader.readAsDataURL(file);
      });
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
    setPreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleProcess = async () => {
    if (previews.length === 0) return;
    setIsProcessing(true);
    setSaveStatus(null);
    try {
      const data = await processInvoices(previews);
      setResult(data);
    } catch (error) {
      console.error(error);
      alert("Error al procesar las facturas. Intente de nuevo.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConnectGoogle = async () => {
    const response = await fetch('/api/auth/url');
    const { url } = await response.json();
    window.open(url, 'google_oauth', 'width=600,height=700');
  };

  const handleSelectFromDrive = useCallback(() => {
    if (!googleTokens || !config) return;

    if (!config.developerKey || config.developerKey === 'secret_key_123' || config.developerKey === '') {
      alert("Falta configurar la 'GOOGLE_API_KEY' en los Secrets de la aplicación para usar Google Drive.");
      return;
    }

    setIsDriveLoading(true);

    const loadPicker = () => {
      window.gapi.load('picker', {
        callback: () => {
          const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS);
          view.setMimeTypes('image/jpeg,image/png,application/pdf');
          
          const picker = new window.google.picker.PickerBuilder()
            .enableFeature(window.google.picker.Feature.NAV_HIDDEN)
            .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
            .setAppId(config.clientId)
            .setOAuthToken(googleTokens.access_token)
            .addView(view)
            .setDeveloperKey(config.developerKey)
            .setCallback(async (data: any) => {
              if (data.action === window.google.picker.Action.PICKED) {
                const docs = data.docs;
                for (const doc of docs) {
                  try {
                    const fileId = doc.id;
                    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                      headers: {
                        'Authorization': `Bearer ${googleTokens.access_token}`
                      }
                    });
                    
                    const blob = await response.blob();
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      const base64 = reader.result as string;
                      setPreviews(prev => [...prev, base64]);
                      // We don't have the "File" object but we have the preview
                      // The processInvoices function uses previews (base64)
                    };
                    reader.readAsDataURL(blob);
                  } catch (err) {
                    console.error("Error fetching file from Drive:", err);
                  }
                }
              }
              if (data.action === window.google.picker.Action.CANCEL || data.action === window.google.picker.Action.PICKED) {
                setIsDriveLoading(false);
              }
            })
            .build();
          picker.setVisible(true);
        }
      });
    };

    if (!window.gapi) {
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onload = loadPicker;
      document.body.appendChild(script);
    } else {
      loadPicker();
    }
  }, [googleTokens, config]);

  const handleSaveToSheets = async () => {
    if (!googleTokens || !result) return;
    setIsSaving(true);
    setSaveStatus(null);

    const formatValue = (val: string | number, type: 'date' | 'number' | 'currency') => {
      if (val === 'No disponible') return val;
      const str = String(val).replace(',', '.'); // Normalize to dot for parsing
      
      if (type === 'date') {
        const parts = str.split('-');
        if (parts.length === 3) {
          return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        return str;
      }
      
      const num = parseFloat(str);
      if (isNaN(num)) return str;

      if (type === 'number') {
        return num.toLocaleString('es-AR', { maximumFractionDigits: 3 });
      }
      
      if (type === 'currency') {
        return `$ ${num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      
      return str;
    };

    const values = result.items.map(item => [
      formatValue(item.date, 'date'),
      item.vendorName,
      item.invoiceNumber,
      formatValue(item.quantity, 'number'),
      item.unitOfMeasure,
      item.itemDetail,
      formatValue(item.unitPriceWithoutVat, 'currency'),
      formatValue(item.totalPriceWithoutVat, 'currency')
    ]);

    try {
      const response = await fetch('/api/sheets/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokens: googleTokens,
          spreadsheetId: SPREADSHEET_ID,
          values
        })
      });

      const data = await response.json();
      if (response.ok) {
        setSaveStatus({ type: 'success', message: data.message });
      } else {
        setSaveStatus({ type: 'error', message: data.error || "Error al guardar" });
      }
    } catch (error) {
      setSaveStatus({ type: 'error', message: "Error de conexión con el servidor" });
    } finally {
      setIsSaving(false);
    }
  };

  const updateItem = (index: number, field: keyof InvoiceItem, value: string) => {
    if (!result) return;
    const newItems = [...result.items];
    newItems[index] = { ...newItems[index], [field]: value };
    setResult({ ...result, items: newItems });
  };

  const addItem = () => {
    if (!result) return;
    const newItem: InvoiceItem = {
      date: new Date().toISOString().split('T')[0],
      vendorName: 'Nuevo Proveedor',
      invoiceNumber: '000',
      quantity: '1',
      unitOfMeasure: 'unidades',
      itemDetail: 'Nuevo artículo',
      unitPriceWithoutVat: '0',
      totalPriceWithoutVat: '0'
    };
    setResult({ ...result, items: [...result.items, newItem] });
  };

  const deleteItem = (index: number) => {
    if (!result) return;
    const newItems = result.items.filter((_, i) => i !== index);
    setResult({ ...result, items: newItems });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
      {/* Decorative Background Elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] rounded-full bg-indigo-500/5 blur-[120px]" />
        <div className="absolute top-[20%] -right-[5%] w-[30%] h-[30%] rounded-full bg-violet-500/5 blur-[100px]" />
        <div className="absolute -bottom-[10%] left-[20%] w-[50%] h-[50%] rounded-full bg-emerald-500/5 blur-[150px]" />
      </div>

      {/* Header */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-indigo-600 to-violet-700 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-200 rotate-3 hover:rotate-0 transition-transform duration-300">
              <FileText size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-600">Invoice AI</h1>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em]">Intelligent Processing</p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <a 
              href={SPREADSHEET_URL} 
              target="_blank" 
              rel="noopener noreferrer"
              className="hidden md:flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all"
            >
              <TableIcon size={16} />
              <span>Ver Planilla</span>
              <ExternalLink size={14} className="opacity-50" />
            </a>
            
            <div className="h-8 w-[1px] bg-slate-200 mx-2 hidden md:block" />

            {!googleTokens ? (
              <button 
                onClick={handleConnectGoogle}
                className="bg-indigo-600 text-white px-6 py-2.5 rounded-full text-sm font-bold hover:bg-indigo-700 shadow-md shadow-indigo-100 transition-all active:scale-95 flex items-center gap-2"
              >
                Conectar Google
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-emerald-50 text-emerald-700 px-4 py-2 rounded-full border border-emerald-100 shadow-sm shadow-emerald-50">
                  <CheckCircle2 size={16} className="text-emerald-500" />
                  <span className="text-sm font-bold">Conectado</span>
                </div>
                <button 
                  onClick={() => {
                    setGoogleTokens(null);
                    localStorage.removeItem('google_tokens');
                  }}
                  className="text-xs font-bold text-slate-400 hover:text-red-500 transition-colors"
                >
                  Desconectar
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12 relative z-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Left Column: Upload & Instructions */}
          <div className="lg:col-span-4 space-y-6">
            <section className="bg-white rounded-[2rem] p-8 shadow-xl shadow-slate-200/50 border border-slate-100">
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-xl font-bold flex items-center gap-3">
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
                    <Upload size={20} />
                  </div>
                  Subir Facturas
                </h2>
                {files.length > 0 && (
                  <button 
                    onClick={() => { setFiles([]); setPreviews([]); setResult(null); }}
                    className="text-xs font-bold text-red-500 hover:underline"
                  >
                    Limpiar todo
                  </button>
                )}
              </div>
              
              <div className="space-y-6">
                <label className="group relative flex flex-col items-center justify-center w-full h-56 border-2 border-dashed border-slate-200 rounded-[1.5rem] cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30 transition-all duration-300">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mb-4 group-hover:scale-110 group-hover:bg-white group-hover:shadow-lg transition-all duration-300">
                      <Plus className="text-indigo-500" size={32} />
                    </div>
                    <p className="text-sm font-bold text-slate-700">Arrastra tus archivos aquí</p>
                    <p className="text-xs text-slate-400 mt-2">Soporta JPG, PNG y PDF</p>
                  </div>
                  <input type="file" multiple className="hidden" onChange={handleFileChange} accept="image/*" />
                </label>

                {googleTokens && (
                  <button
                    onClick={handleSelectFromDrive}
                    disabled={isDriveLoading}
                    className="w-full py-3 px-4 border-2 border-indigo-100 rounded-2xl text-indigo-600 font-bold hover:bg-indigo-50 transition-all flex items-center justify-center gap-2"
                  >
                    {isDriveLoading ? <Loader2 className="animate-spin" size={20} /> : <Upload size={20} />}
                    Seleccionar de Google Drive
                  </button>
                )}

                <AnimatePresence>
                  {previews.length > 0 && (
                    <div className="grid grid-cols-3 gap-3">
                      {previews.map((src, i) => (
                        <motion.div 
                          key={i}
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          className="relative aspect-square rounded-xl overflow-hidden border border-slate-100 group shadow-sm"
                        >
                          <img src={src} className="w-full h-full object-cover" alt="Preview" referrerPolicy="no-referrer" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button 
                              onClick={() => removeFile(i)}
                              className="bg-white text-red-500 p-2 rounded-full hover:scale-110 transition-transform"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  )}
                </AnimatePresence>

                <button
                  disabled={files.length === 0 || isProcessing}
                  onClick={handleProcess}
                  className={cn(
                    "w-full py-4 rounded-2xl font-bold text-white transition-all flex items-center justify-center gap-3 shadow-lg",
                    files.length === 0 || isProcessing 
                      ? "bg-slate-200 text-slate-400 cursor-not-allowed shadow-none" 
                      : "bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 hover:shadow-indigo-200 active:scale-[0.98]"
                  )}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="animate-spin" size={22} />
                      <span>Procesando con IA...</span>
                    </>
                  ) : (
                    <>
                      <ChevronRight size={22} />
                      <span>Analizar Facturas</span>
                    </>
                  )}
                </button>
              </div>
            </section>

            <section className="bg-indigo-900 text-white rounded-[2rem] p-8 shadow-xl shadow-indigo-900/20 overflow-hidden relative">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-16 -mt-16 blur-2xl" />
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <Info size={20} className="text-indigo-300" />
                ¿Cómo funciona?
              </h3>
              <ul className="space-y-4 text-sm text-indigo-100/80 font-medium">
                <li className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-indigo-800 flex items-center justify-center text-[10px] font-bold text-indigo-300 flex-shrink-0">01</span>
                  <span>Sube fotos de tus facturas o tickets de compra.</span>
                </li>
                <li className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-indigo-800 flex items-center justify-center text-[10px] font-bold text-indigo-300 flex-shrink-0">02</span>
                  <span>Gemini IA extraerá automáticamente los datos y calculará los importes sin IVA.</span>
                </li>
                <li className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-indigo-800 flex items-center justify-center text-[10px] font-bold text-indigo-300 flex-shrink-0">03</span>
                  <span>Revisa los resultados y guárdalos directamente en tu Google Sheet.</span>
                </li>
              </ul>
            </section>
          </div>

          {/* Right Column: Data Table */}
          <div className="lg:col-span-8">
            <section className="bg-white rounded-[2rem] shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden min-h-[600px] flex flex-col">
              <div className="p-8 border-b border-slate-50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white sticky top-0 z-10">
                <div>
                  <h2 className="text-xl font-bold flex items-center gap-3">
                    <div className="p-2 bg-violet-50 text-violet-600 rounded-lg">
                      <TableIcon size={20} />
                    </div>
                    Datos Extraídos
                  </h2>
                  <p className="text-sm text-slate-400 font-medium mt-1">Verifica la información antes de exportar</p>
                </div>
                
                {result && (
                  <div className="flex items-center gap-3 w-full sm:w-auto">
                    <button 
                      onClick={addItem}
                      className="p-3 rounded-xl border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-all text-slate-600"
                      title="Agregar fila"
                    >
                      <Plus size={20} />
                    </button>
                    <button
                      disabled={isSaving || !googleTokens}
                      onClick={handleSaveToSheets}
                      className={cn(
                        "flex-1 sm:flex-none px-8 py-3 rounded-xl font-bold text-white transition-all flex items-center justify-center gap-2 shadow-lg",
                        isSaving || !googleTokens
                          ? "bg-slate-200 text-slate-400 cursor-not-allowed shadow-none"
                          : "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-100 active:scale-95"
                      )}
                    >
                      {isSaving ? <Loader2 className="animate-spin" size={20} /> : <Save size={20} />}
                      <span>Exportar a Sheets</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-x-auto">
                {!result ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-300 p-12 text-center min-h-[400px]">
                    <div className="w-24 h-24 bg-slate-50 rounded-3xl flex items-center justify-center mb-8 rotate-6">
                      <TableIcon size={48} className="text-slate-200" />
                    </div>
                    <p className="text-xl font-bold text-slate-400">Esperando datos...</p>
                    <p className="text-sm max-w-xs mt-3 font-medium text-slate-400/70">
                      Cuando proceses tus facturas, los detalles aparecerán en esta tabla interactiva.
                    </p>
                  </div>
                ) : (
                  <div className="p-2">
                    <table className="w-full text-left border-separate border-spacing-0 min-w-[1100px]">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-[0.2em] font-extrabold text-slate-400">
                          <th className="px-6 py-5 border-b border-slate-50">Fecha</th>
                          <th className="px-6 py-5 border-b border-slate-50">Proveedor</th>
                          <th className="px-6 py-5 border-b border-slate-50">Factura #</th>
                          <th className="px-6 py-5 border-b border-slate-50">Cant.</th>
                          <th className="px-6 py-5 border-b border-slate-50">Unidad</th>
                          <th className="px-6 py-5 border-b border-slate-50">Detalle</th>
                          <th className="px-6 py-5 border-b border-slate-50">P. Unit (S/IVA)</th>
                          <th className="px-6 py-5 border-b border-slate-50">Total (S/IVA)</th>
                          <th className="px-6 py-5 border-b border-slate-50"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {result.items.map((item, idx) => (
                          <tr key={idx} className="group hover:bg-indigo-50/30 transition-colors">
                            <td className="px-4 py-4">
                              <input 
                                type="text" 
                                value={item.date} 
                                onChange={(e) => updateItem(idx, 'date', e.target.value)}
                                className={cn("w-full bg-transparent border-none focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-1 text-sm font-medium", item.date === 'No disponible' && "text-red-500")}
                              />
                            </td>
                            <td className="px-4 py-4">
                              <input 
                                type="text" 
                                value={item.vendorName} 
                                onChange={(e) => updateItem(idx, 'vendorName', e.target.value)}
                                className={cn("w-full bg-transparent border-none focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-1 text-sm font-bold text-slate-700", item.vendorName === 'No disponible' && "text-red-500")}
                              />
                            </td>
                            <td className="px-4 py-4">
                              <input 
                                type="text" 
                                value={item.invoiceNumber} 
                                onChange={(e) => updateItem(idx, 'invoiceNumber', e.target.value)}
                                className={cn("w-full bg-transparent border-none focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-1 text-sm font-medium text-slate-500", item.invoiceNumber === 'No disponible' && "text-red-500")}
                              />
                            </td>
                            <td className="px-4 py-4 w-20">
                              <input 
                                type="text" 
                                value={item.quantity} 
                                onChange={(e) => updateItem(idx, 'quantity', e.target.value)}
                                className={cn("w-full bg-transparent border-none focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-1 text-sm text-center font-bold", item.quantity === 'No disponible' && "text-red-500")}
                              />
                            </td>
                            <td className="px-4 py-4 w-24">
                              <input 
                                type="text" 
                                value={item.unitOfMeasure} 
                                onChange={(e) => updateItem(idx, 'unitOfMeasure', e.target.value)}
                                className={cn("w-full bg-transparent border-none focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-1 text-xs text-slate-400 font-bold uppercase", item.unitOfMeasure === 'No disponible' && "text-red-500")}
                              />
                            </td>
                            <td className="px-4 py-4">
                              <input 
                                type="text" 
                                value={item.itemDetail} 
                                onChange={(e) => updateItem(idx, 'itemDetail', e.target.value)}
                                className={cn("w-full bg-transparent border-none focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-1 text-sm text-slate-600", item.itemDetail === 'No disponible' && "text-red-500")}
                              />
                            </td>
                            <td className="px-4 py-4 w-32">
                              <input 
                                type="text" 
                                value={item.unitPriceWithoutVat} 
                                onChange={(e) => updateItem(idx, 'unitPriceWithoutVat', e.target.value)}
                                className={cn("w-full bg-transparent border-none focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-1 text-sm font-mono text-indigo-600 font-bold", item.unitPriceWithoutVat === 'No disponible' && "text-red-500")}
                              />
                            </td>
                            <td className="px-4 py-4 w-32">
                              <input 
                                type="text" 
                                value={item.totalPriceWithoutVat} 
                                onChange={(e) => updateItem(idx, 'totalPriceWithoutVat', e.target.value)}
                                className={cn("w-full bg-transparent border-none focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-1 text-sm font-mono font-extrabold text-slate-900", item.totalPriceWithoutVat === 'No disponible' && "text-red-500")}
                              />
                            </td>
                            <td className="px-4 py-4">
                              <button 
                                onClick={() => deleteItem(idx)}
                                className="w-8 h-8 rounded-full flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                              >
                                <Trash2 size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <AnimatePresence>
                {saveStatus && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className={cn(
                      "px-8 py-4 flex items-center gap-3 border-t",
                      saveStatus.type === 'success' 
                        ? "bg-emerald-50 text-emerald-700 border-emerald-100" 
                        : "bg-red-50 text-red-700 border-red-100"
                    )}
                  >
                    {saveStatus.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                    <span className="text-sm font-bold">{saveStatus.message}</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-6 py-16 border-t border-slate-200 text-center relative z-10">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center text-slate-400">
            <FileText size={20} />
          </div>
          <p className="text-sm text-slate-400 font-bold tracking-wide">
            POWERED BY GEMINI AI & GOOGLE CLOUD
          </p>
          <div className="flex gap-6 mt-4">
            <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Seguro</span>
            <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Rápido</span>
            <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Preciso</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
