/**
 * PDF export utility — generates a complete analysis report
 */
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import type { AnalysisResult } from './network-analysis';
import { modeLabels } from './gtfs-types';
import { generateSignageRecommendations } from '@/components/SignageGuide';

interface ExportOptions {
  analysis: AnalysisResult;
  fileName: string;
  densityRef: HTMLElement | null;
  transitRef: HTMLElement | null;
  frictionRef: HTMLElement | null;
  onProgress?: (step: string) => void;
}

export async function exportPdfReport({
  analysis,
  fileName,
  densityRef,
  transitRef,
  frictionRef,
  onProgress,
}: ExportOptions): Promise<void> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = 210;
  const margin = 15;
  const contentW = pageW - margin * 2;
  let y = margin;

  const addText = (text: string, size: number, opts?: { bold?: boolean; color?: [number, number, number]; mono?: boolean }) => {
    pdf.setFontSize(size);
    pdf.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    if (opts?.color) pdf.setTextColor(...opts.color);
    else pdf.setTextColor(30, 30, 30);
    const lines = pdf.splitTextToSize(text, contentW);
    pdf.text(lines, margin, y);
    y += lines.length * (size * 0.45) + 2;
  };

  const ensureSpace = (needed: number) => {
    if (y + needed > 280) {
      pdf.addPage();
      y = margin;
    }
  };

  // --- Title page ---
  y = 50;
  addText('GTFS Network Analysis', 22, { bold: true });
  y += 4;
  addText(`Rapport d'analyse — ${fileName}`, 11, { color: [120, 120, 120] });
  y += 2;
  addText(`Généré le ${new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}`, 9, { color: [150, 150, 150] });
  y += 10;

  // Network summary
  const m = analysis.networkMetrics;
  addText('Résumé du réseau', 14, { bold: true });
  y += 2;
  const summaryLines = [
    `Lignes : ${m.totalRoutes}`,
    `Arrêts : ${m.totalStops}`,
    `Correspondances : ${m.totalCorrespondences}`,
    `Friction moyenne : ${m.averageFriction.toFixed(2)}`,
    `Redondance : ${(m.networkRedundancy * 100).toFixed(1)}%`,
    `Lisibilité : ${(m.readabilityScore * 100).toFixed(0)}%`,
  ];
  for (const line of summaryLines) {
    addText(`  • ${line}`, 9);
  }

  // Mode breakdown
  y += 4;
  addText('Répartition par mode', 12, { bold: true });
  y += 2;
  const modeCounts = new Map<string, number>();
  for (const r of analysis.routes) {
    modeCounts.set(r.mode, (modeCounts.get(r.mode) || 0) + 1);
  }
  for (const [mode, count] of modeCounts) {
    addText(`  • ${modeLabels[mode as keyof typeof modeLabels] || mode} : ${count} lignes`, 9);
  }

  // --- Capture views ---
  const captureElement = async (el: HTMLElement | null, label: string): Promise<HTMLCanvasElement | null> => {
    if (!el) return null;
    onProgress?.(`Capture ${label}...`);
    return html2canvas(el, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    });
  };

  onProgress?.('Capture des diagrammes...');
  const [densityCanvas, transitCanvas, frictionCanvas] = await Promise.all([
    captureElement(densityRef, 'Densité circulaire'),
    captureElement(transitRef, 'Correspondances'),
    captureElement(frictionRef, 'Friction'),
  ]);

  const addCanvasPage = (canvas: HTMLCanvasElement | null, title: string) => {
    if (!canvas) return;
    pdf.addPage();
    y = margin;
    addText(title, 16, { bold: true });
    y += 4;

    const imgData = canvas.toDataURL('image/png');
    const ratio = canvas.height / canvas.width;
    const imgW = contentW;
    const imgH = imgW * ratio;

    // If too tall, scale down
    const maxH = 240;
    const finalW = imgH > maxH ? (maxH / ratio) : imgW;
    const finalH = imgH > maxH ? maxH : imgH;

    pdf.addImage(imgData, 'PNG', margin, y, finalW, finalH);
    y += finalH + 4;
  };

  addCanvasPage(densityCanvas, 'Vue 1 — Diagramme de densité circulaire');
  addCanvasPage(transitCanvas, 'Vue 2 — Diagramme de correspondances');
  addCanvasPage(frictionCanvas, 'Vue 3 — Analyse de friction');

  // --- Top friction stations page ---
  pdf.addPage();
  y = margin;
  addText('Stations à forte friction', 14, { bold: true });
  y += 4;
  const topStations = analysis.stationMetrics.slice(0, 20);
  for (const s of topStations) {
    ensureSpace(6);
    addText(`${s.frictionIndex.toFixed(2)}  ${s.stopName} — ${s.routeCount} lignes, ${s.correspondences} corr.`, 8);
  }

  // Top overloaded routes
  y += 6;
  ensureSpace(20);
  addText('Lignes surchargées', 14, { bold: true });
  y += 4;
  const routeConnectionCount = new Map<string, number>();
  for (const c of analysis.correspondences) {
    routeConnectionCount.set(c.routeA, (routeConnectionCount.get(c.routeA) || 0) + c.weight);
    routeConnectionCount.set(c.routeB, (routeConnectionCount.get(c.routeB) || 0) + c.weight);
  }
  const topRoutes = analysis.routes
    .map(r => ({ ...r, connections: routeConnectionCount.get(r.routeId) || 0 }))
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 15);
  for (const r of topRoutes) {
    ensureSpace(6);
    addText(`${r.name} — ${r.connections} connexions, ${r.stopCount} arrêts`, 8);
  }

  // --- Signage Recommendations page ---
  pdf.addPage();
  y = margin;
  addText('Recommandations signalétiques — Top 10 stations', 14, { bold: true });
  y += 2;
  addText('Actions terrain basées sur l\'analyse de friction et de centralité', 9, { color: [120, 120, 120] });
  y += 6;

  const recommendations = generateSignageRecommendations(analysis);
  for (const rec of recommendations) {
    ensureSpace(30);
    const levelLabel = rec.level === 'critical' ? '🔴 CRITIQUE' : rec.level === 'warning' ? '🟡 ATTENTION' : '🟢 STANDARD';
    addText(`${levelLabel} — ${rec.station}`, 10, { bold: true });
    addText(`  Friction: ${rec.friction.toFixed(2)} · ${rec.routeCount} lignes · ${rec.correspondences} correspondances`, 8, { color: [100, 100, 100] });
    y += 1;
    for (const action of rec.actions) {
      ensureSpace(5);
      addText(`    → ${action}`, 8);
    }
    y += 3;
  }

  // Translation table
  ensureSpace(50);
  y += 4;
  addText('Grille de lecture terrain', 12, { bold: true });
  y += 2;
  const gridLines = [
    'Station friction > 3.0 → Renforcer signalétique directionnelle (panneaux, jalonnement, écrans)',
    'Station avec beaucoup de correspondances → Ajouter plans de quartier, totems, personnel',
    'Ligne structurante (beaucoup de correspondances) → Prévoir itinéraires de substitution fléchés',
    'Station périphérique isolée → Info voyageur vers le hub le plus proche',
    'Redondance réseau < 20% → Communiquer les itinéraires bis en cas de perturbation',
  ];
  for (const line of gridLines) {
    ensureSpace(8);
    addText(`  • ${line}`, 8);
  }

  onProgress?.('Finalisation...');
  pdf.save(`${fileName.replace('.zip', '')}-rapport.pdf`);
}
