import jsPDF from 'jspdf';
import { toPng } from 'html-to-image';
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

async function waitForImages(el: HTMLElement): Promise<void> {
  const imgs = Array.from(el.querySelectorAll<HTMLImageElement>('img'));
  await Promise.all(
    imgs.map(img =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>(resolve => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }),
    ),
  );
}

async function captureElement(el: HTMLElement, hasLeaflet: boolean): Promise<string | null> {
  const style = getComputedStyle(el);
  const wasHidden = style.display === 'none';

  if (wasHidden) {
    el.style.display = 'block';
    el.style.position = 'fixed';
    el.style.top = '-99999px';
    el.style.left = '0';
    el.style.width = '1100px';
    el.style.zIndex = '-1';
    el.style.visibility = 'visible';
    el.style.pointerEvents = 'none';
  }

  try {
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    if (hasLeaflet) {
      const map = el.querySelector('.leaflet-container') as HTMLElement | null;
      if (map) {
        window.dispatchEvent(new Event('resize'));
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await waitForImages(el);

    return await toPng(el, {
      backgroundColor: '#ffffff',
      pixelRatio: 2,
      skipFonts: false,
      fetchRequestInit: { mode: 'cors' },
    });
  } catch {
    return null;
  } finally {
    if (wasHidden) {
      el.style.display = '';
      el.style.position = '';
      el.style.top = '';
      el.style.left = '';
      el.style.width = '';
      el.style.zIndex = '';
      el.style.visibility = '';
      el.style.pointerEvents = '';
    }
  }
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

  const addText = (
    text: string,
    size: number,
    opts?: { bold?: boolean; color?: [number, number, number] },
  ) => {
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
  addText(
    `Généré le ${new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    9,
    { color: [150, 150, 150] },
  );
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
  ]) {
    addText(`  • ${line}`, 9);
  }

  y += 4;
  addText('Répartition par mode', 12, { bold: true });
  y += 2;
  const modeCounts = new Map<string, number>();
  for (const r of analysis.routes) modeCounts.set(r.mode, (modeCounts.get(r.mode) || 0) + 1);
  for (const [mode, count] of modeCounts) {
    addText(`  • ${modeLabels[mode as keyof typeof modeLabels] || mode} : ${count} lignes`, 9);
  }

  const addImagePage = (dataUrl: string, title: string) => {
    pdf.addPage();
    y = margin;
    addText(title, 16, { bold: true });
    y += 4;
    const img = new Image();
    img.src = dataUrl;
    const maxH = 240;
    const ratio = img.height / img.width || 0.75;
    const finalW = Math.min(contentW, maxH / ratio);
    const finalH = finalW * ratio;
    pdf.addImage(dataUrl, 'PNG', margin, y, finalW, finalH);
    y += finalH + 4;
  };

  const views: [HTMLElement | null | undefined, string, boolean][] = [
    [densityRef, 'Vue 1 — Diagramme de densité circulaire', false],
    [transitRef, 'Vue 2 — Diagramme de correspondances', false],
    [frictionRef, 'Vue 3 — Analyse de friction', false],
    [isochroneRef, 'Vue 4 — Carte isochrone', true],
  ];

  for (const [el, title, hasLeaflet] of views) {
    if (!el) continue;
    onProgress?.(`Capture : ${title.split('—')[1]?.trim() ?? title}`);
    const dataUrl = await captureElement(el, hasLeaflet);
    if (dataUrl) addImagePage(dataUrl, title);
  }

  pdf.addPage();
  y = margin;
  addText('Stations à forte friction', 14, { bold: true });
  y += 4;
  for (const s of analysis.stationMetrics.slice(0, 20)) {
    ensureSpace(6);
    addText(
      `${s.frictionIndex.toFixed(2)}  ${s.stopName} — ${s.routeCount} lignes, ${s.correspondences} corr.`,
      8,
    );
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
  const topRoutes = analysis.routes
    .map(r => ({ ...r, connections: routeConns.get(r.routeId) || 0 }))
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 15);
  for (const r of topRoutes) {
    ensureSpace(6);
    addText(`${r.name} — ${r.connections} connexions, ${r.stopCount} arrêts`, 8);
  }

  pdf.addPage();
  y = margin;
  addText('Recommandations signalétiques — Top 10 stations', 14, { bold: true });
  y += 2;
  addText("Actions terrain basées sur l'analyse de friction et de centralité", 9, {
    color: [120, 120, 120],
  });
  y += 6;

  const recommendations = generateSignageRecommendations(analysis);
  for (const rec of recommendations) {
    ensureSpace(30);
    const levelLabel =
      rec.level === 'critical' ? '! CRITIQUE' : rec.level === 'warning' ? '~ ATTENTION' : '- STANDARD';
    addText(`${levelLabel} — ${rec.station}`, 10, { bold: true });
    addText(
      `  Friction: ${rec.friction.toFixed(2)} · ${rec.routeCount} lignes · ${rec.correspondences} correspondances`,
      8,
      { color: [100, 100, 100] },
    );
    y += 1;
    for (const action of rec.actions) {
      ensureSpace(5);
      addText(`    -> ${action}`, 8);
    }
    y += 3;
  }

  onProgress?.('Finalisation...');
  pdf.save(`${fileName.replace('.zip', '')}-rapport.pdf`);
}
