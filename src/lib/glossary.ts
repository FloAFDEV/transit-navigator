/**
 * Glossary of transit network analysis terms
 */

export interface GlossaryEntry {
  term: string;
  simple: string;
  decision: string;
}

export const glossaryEntries: GlossaryEntry[] = [
  {
    term: 'Densité de réseau',
    simple: 'Le nombre de lignes de transport qui couvrent une zone donnée. Plus il y a de lignes, plus le réseau est dense.',
    decision: 'Un réseau dense offre plus d\'options aux usagers. Une densité faible peut signaler un besoin de nouvelles lignes ou de réorganisation.',
  },
  {
    term: 'Correspondance',
    simple: 'Un point où un voyageur peut passer d\'une ligne à une autre, généralement dans la même station ou un arrêt proche.',
    decision: 'Le nombre et la qualité des correspondances déterminent la fluidité du réseau. Trop de correspondances obligatoires allongent les trajets.',
  },
  {
    term: 'Indice de friction',
    simple: 'Un score qui mesure la complexité des échanges dans une station : combien de correspondances sont possibles rapporté au nombre de lignes.',
    decision: 'Un indice élevé signale un nœud critique. Il peut s\'agir d\'un hub bien conçu, ou d\'un point de congestion à surveiller.',
  },
  {
    term: 'Centralité',
    simple: 'L\'importance d\'une station dans le réseau : combien de lignes y passent (degré) et combien de trajets la traversent (intermédiarité).',
    decision: 'Les stations très centrales sont des points stratégiques. Leur dysfonctionnement impacte tout le réseau.',
  },
  {
    term: 'Redondance',
    simple: 'La proportion de lignes qui partagent des stations communes. Un réseau redondant offre des itinéraires alternatifs.',
    decision: 'Une redondance modérée est souhaitable pour la résilience. Trop de redondance peut indiquer un gaspillage de ressources.',
  },
  {
    term: 'Lisibilité du réseau',
    simple: 'La facilité avec laquelle un usager peut comprendre et naviguer dans le réseau sans aide extérieure.',
    decision: 'Un score de lisibilité faible suggère un besoin de simplification des parcours ou d\'amélioration de la signalétique.',
  },
  {
    term: 'Zone sous-desservie',
    simple: 'Une partie du réseau où les lignes ont peu de correspondances et d\'interconnexions avec le reste.',
    decision: 'Ces zones peuvent isoler des usagers. Elles sont prioritaires pour de nouvelles connexions ou des ajustements de tracé.',
  },
];
