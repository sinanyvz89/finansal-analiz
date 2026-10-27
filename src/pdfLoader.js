/* PDF okuyucu yalnizca PDF secildiginde yuklenir (uygulamanin acilisini yavaslatmaz). */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { pdfToMizanRows, PDF_ERRORS } from "./pdfMizan.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function readPdfMizan(arrayBuffer, onProgress) {
  const res = await pdfToMizanRows(new Uint8Array(arrayBuffer), pdfjsLib, onProgress);
  if (!res.rows) return { rows: null, error: PDF_ERRORS[res.error] || "PDF okunamadi." };
  return { rows: res.rows, info: res.info };
}

// Ana ekrana eklenmis uygulamada PDF okuyucuyu onceden indir: internetsiz de PDF acilabilsin
export function warmUp() {
  return fetch(workerUrl).catch(() => null);
}
