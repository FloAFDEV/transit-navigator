import jsPDF from 'jspdf';
import type { AnalysisResult } from './network-analysis';
import { modeLabels } from './gtfs-types';
import { generateSignageRecommendations } from '@/components/SignageGuide';

interface ExportOptions {
  analysis: AnalysisResult;
  fileName: string;
  densityRef: HTMLElement | null;
  transitRef: HTMLElement | null;
  frictionRef: HTMLElement | null;
  isochroneRef?: HTMLElement | null;
  onProgress?: (step: string) => void;
}

function inlineVars(orig: SVGSVGElement, clone: SVGSVGElement): void {
  const origEls = [orig as SVGElement, ...Array.from(orig.querySelectorAll<SVGElement>('*'))];
  const cloneEls = [clone as SVGElement, ...Array.from(clone.querySelectorAll<SVGElement>('*'))];
  origEls.forEach((origEl, i) => {
    const cloneEl = cloneEls[i];
    if (!cloneEl) return;
    const cs = getComputedStyle(origEl);
    for (const attr of ['fill', 'stroke', 'color'] as const) {
      const raw = cloneEl.getAttribute(attr) ?? '';
      if (raw.includes('var(')) {
        const resolved = cs.getPropertyValue(attr).trim();
        if (resolved) cloneEl.setAttribute(attr, resolved);
      }
    }
  });
}

async function captureSvg(container: HTMLElement): Promise<{ dataUrl: string; w: number; h: number } | null> {
  const origSvg = container.querySelector<SVGSVGElement>('svg');
  if (!origSvg) return null;

  const w = origSvg.clientWidth || Number(origSvg.getAttribute('width')) || 600;
  const h = origSvg.clientHeight || Number(origSvg.getAttribute('height')) || 600;

  const clone = origSvg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  inlineVars(origSvg, clone);

  const svgStr = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise<{ dataUrl: string; w: number; h: number } | null>(resolve => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    img.onload = () => {
      if (!ctx) { URL.revokeObjectURL(url); resolve(null); return; }
      canvas.width = w * 2;
      canvas.height = h * 2;
      ctx.scale(2, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      try {
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL('image/png'), w, h });
      } catch {
        resolve(null);
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export async function exportPdfReport({
  analysis,
  fileName,
  densityRef,
  transitRef,
  frictionRef,
  isochroneRef,
  onProgress,
}: ExportOptions): Promise<void> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = 210;
  const margin = 15;
  const contentW = pageW - margin * 2;
  let y = margin;

  const addText = (text: string, size: number, opts?: { bold?: boolean; color?: [number, number, number] }) => {
    pdf.setFontSize(size);
    pdf.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    if (opts?.color) pdf.setTextColor(...opts.color);
    else pdf.setTextColor(30, 30, 30);
    const lines = pdf.splitTextToSize(text, contentW);
    pdf.text(lines, margin, y);
    y += lines.length * (size * 0.45) + 2;
  };

  const ensureSpace = (needed: number) => {
    if (y + needed > 280) { pdf.addPage(); y = margin; }
  };

  y = 50;
  addText('GTFS Network Analysis', 22, { bold: true });
  y += 4;
  addText(`Rapport d'analyse — ${fileName}`, 11, { color: [120, 120, 120] });
  y += 2;
  addText(`Généré le ${new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}`, 9, { color: [150, 150, 150] });
  y += 10;

  const m = analysis.networkMetrics;
  addText('Résumé du réseau', 14, { bold: true });
  y += 2;
  for (const line of [
    `Lignes : ${m.totalRoutes}`,
    `Arrêts : ${m.totalStops}`,
    `Correspondances : ${m.totalCorrespondences}`,
    `Friction moyenne : ${m.averageFriction.toFixed(2)}`,
    `Redondance : ${(m.networkRedundancy * 100).toFixed(1)}%`,
    `Lisibilité : ${(m.readabilityScore * 100).toFixed(0)}%`,
  ]) addText(`  • ${line}`, 9);

  y += 4;
  addText('Répartition par mode', 12, { bold: true });
  y += 2;
  const modeCounts = new Map<string, number>();
  for (const r of analysis.routes) modeCounts.set(r.mode, (modeCounts.get(r.mode) || 0) + 1);
  for (const [mode, count] of modeCounts)
    addText(`  • ${modeLabels[mode as keyof typeof modeLabels] || mode} : ${count} lignes`, 9);

  const views: [HTMLElement | null | undefined, string][] = [
    [densityRef, 'Vue 1 — Densité circulaire'],
    [transitRef, 'Vue 2 — Correspondances'],
    [frictionRef, 'Vue 3 — Friction'],
    [isochroneRef, 'Vue 4 — Isochrone radial'],
  ];

  for (const [el, title] of views) {
    if (!el) continue;
    onProgress?.(`Capture : ${title.split('—')[1]?.trim() ?? title}`);
    const result = await captureSvg(el);
    if (!result) continue;
    const { dataUrl, w, h } = result;
    pdf.addPage();
    y = margin;
    addText(title, 16, { bold: true });
    y += 4;
    const ratio = h / w;
    const maxH = 240;
    const finalW = ratio > 0 ? Math.min(contentW, maxH / ratio) : contentW;
    const finalH = Math.min(finalW * ratio, maxH);
    pdf.addImage(dataUrl, 'PNG', margin, y, finalW, finalH);
    y += finalH + 4;
  }

  pdf.addPage();
  y = margin;
  addText('Stations à forte friction', 14, { bold: true });
  y += 4;
  for (const s of analysis.stationMetrics.slice(0, 20)) {
    ensureSpace(6);
    addText(`${s.frictionIndex.toFixed(2)}  ${s.stopName} — ${s.routeCount} lignes, ${s.correspondences} corr.`, 8);
  }

  y += 6;
  ensureSpace(20);
  addText('Lignes surchargées', 14, { bold: true });
  y += 4;
  const routeConns = new Map<string, number>();
  for (const c of analysis.correspondences) {
    routeConns.set(c.routeA, (routeConns.get(c.routeA) || 0) + c.weight);
    routeConns.set(c.routeB, (routeConns.get(c.routeB) || 0) + c.weight);
  }
  for (const r of analysis.routes.map(r => ({ ...r, connections: routeConns.get(r.routeId) || 0 })).sort((a, b) => b.connections - a.connections).slice(0, 15)) {
    ensureSpace(6);
    addText(`${r.name} — ${r.connections} connexions, ${r.stopCount} arrêts`, 8);
  }

  pdf.addPage();
  y = margin;
  addText('Recommandations signalétiques — Top 10 stations', 14, { bold: true });
  y += 2;
  addText("Actions terrain basées sur l'analyse de friction et de centralité", 9, { color: [120, 120, 120] });
  y += 6;

  for (const rec of generateSignageRecommendations(analysis)) {
    ensureSpace(30);
    const levelLabel = rec.level === 'critical' ? '! CRITIQUE' : rec.level === 'warning' ? '~ ATTENTION' : '- STANDARD';
    addText(`${levelLabel} — ${rec.station}`, 10, { bold: true });
    addText(`  Friction: ${rec.friction.toFixed(2)} · ${rec.routeCount} lignes · ${rec.correspondences} correspondances`, 8, { color: [100, 100, 100] });
    y += 1;
    for (const action of rec.actions) { ensureSpace(5); addText(`    -> ${action}`, 8); }
    y += 3;
  }

  onProgress?.('Finalisation...');
  pdf.save(`${fileName.replace('.zip', '')}-rapport.pdf`);
}
