/**
 * Journey Experience Score (JES)
 *
 * A composite perceived-cost model that weights travel time, transfer count,
 * physical friction, and accessibility barriers. The score is normalized to
 * 0–100 where 100 = frictionless direct trip and 0 = worst-case journey.
 *
 * Weights are empirical — they reflect well-documented cognitive biases:
 *   - Transfer time is perceived ~1.8× longer than in-vehicle time (Wardman 2004)
 *   - Friction (narrow passages, steep stairs) adds perceived time on top
 *   - Accessibility barriers are the most penalizing for affected users
 */
import type { JES, JESBreakdown, TransferCost } from './gtfs-types';

const WEIGHTS: JESBreakdown = {
  travelTimeWeight: 1.0,
  transferPenaltyWeight: 1.8,
  frictionPenaltyWeight: 2.5,
  accessibilityPenaltyWeight: 3.0,
};

// Anchors for normalization
// Perfect: 15-minute direct trip, 0 transfers → ~900s perceived
// Worst:   60-minute trip + 3 transfers with full friction → ~6000s perceived
const PERCEIVED_PERFECT = 900;
const PERCEIVED_WORST = 6000;

/**
 * Compute the JES for a given journey path.
 *
 * @param pathStopIds               Ordered list of stop_ids along the route
 * @param totalTravelSeconds        Pure in-vehicle travel time (Dijkstra result)
 * @param transfers                 Transfer costs at each interchange point
 * @param accessibilityPenaltySec   Extra seconds for accessibility barriers (0 if none)
 */
export function computeJES(
  pathStopIds: string[],
  totalTravelSeconds: number,
  transfers: TransferCost[],
  accessibilityPenaltySec = 0,
): JES {
  const transferCount = transfers.length;
  const totalTransferCostSeconds = transfers.reduce((s, t) => s + t.totalCostSeconds, 0);
  const frictionPenaltySeconds = transfers.reduce((s, t) => s + t.frictionPenalty, 0);

  // Raw perceived cost (seconds)
  const rawScore =
    totalTravelSeconds * WEIGHTS.travelTimeWeight +
    totalTransferCostSeconds * WEIGHTS.transferPenaltyWeight * Math.max(1, transferCount) +
    frictionPenaltySeconds * WEIGHTS.frictionPenaltyWeight +
    accessibilityPenaltySec * WEIGHTS.accessibilityPenaltyWeight;

  // Linear normalization: PERCEIVED_PERFECT → 100, PERCEIVED_WORST → 0
  const normalizedScore = Math.max(
    0,
    Math.min(
      100,
      100 * (1 - (rawScore - PERCEIVED_PERFECT) / (PERCEIVED_WORST - PERCEIVED_PERFECT)),
    ),
  );

  return {
    pathStopIds,
    totalTravelSeconds,
    transferCount,
    totalTransferCostSeconds,
    frictionPenaltySeconds,
    accessibilityPenaltySeconds: accessibilityPenaltySec,
    rawScore,
    normalizedScore,
    breakdown: { ...WEIGHTS },
  };
}

/**
 * Human-readable JES label for display in UI.
 */
export function jesLabel(score: number): { label: string; color: string } {
  if (score >= 80) return { label: 'Excellent', color: 'hsl(142, 71%, 45%)' };
  if (score >= 60) return { label: 'Bon', color: 'hsl(174, 62%, 42%)' };
  if (score >= 40) return { label: 'Acceptable', color: 'hsl(38, 92%, 50%)' };
  if (score >= 20) return { label: 'Difficile', color: 'hsl(24, 90%, 52%)' };
  return { label: 'Critique', color: 'hsl(0, 72%, 51%)' };
}

/**
 * Given a JES, produce a list of concrete improvement actions for signage/UX.
 * Returns actions ordered by impact (highest first).
 */
export function jesImprovementActions(jes: JES): string[] {
  const actions: string[] = [];

  if (jes.frictionPenaltySeconds > 60) {
    actions.push('Réduire la friction physique (jalonnement sol, signalétique directionnelle)');
  }
  if (jes.transferCount >= 2) {
    actions.push('Optimiser les itinéraires de correspondance (réduction à 1 transfert si possible)');
  }
  if (jes.totalTransferCostSeconds > 600) {
    actions.push('Améliorer la fréquence ou synchronisation des correspondances');
  }
  if (jes.accessibilityPenaltySeconds > 0) {
    actions.push('Installer ascenseur ou rampe d\'accès PMR sur les nœuds bloquants');
  }
  if (jes.normalizedScore < 40) {
    actions.push('Prévoir du personnel d\'orientation aux heures de pointe');
    actions.push('Déployer des écrans temps réel à chaque nœud de correspondance');
  }

  return actions;
}
