import useSWR from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";

/**
 * « Ouverture rapide » (Lab bêta, `OPENING_LAB_ENABLED`, DECISIONS §200) : ce compte a-t-il les gestes
 * d'ouverture repris de la R&D de Lumen pour Jellyfin (24/11/2026) ? Ce sont :
 * - les morceaux préparés par la fiche, gardés pour l'ouverture (`sheetHeaderWarmup.ts`, `closePrepared`) ;
 * - la zone de reprise lue depuis la fiche, et demandée dès l'index lu à l'ouverture (`openingLab` de
 *   `probePlaybackPath`).
 *
 * Lue dans la configuration publique, **suivie, jamais demandée** (`followOnlyOptions`) : sans réponse
 * encore — et dans les doubles des empreintes du lecteur, qui n'ont pas cette clé —, c'est « coupé », et
 * l'ouverture est exactement celle d'avant.
 */
export function useOpeningLab(): boolean {
  const { data } = useSWR<{ openingLab?: boolean }>("/api/config/public", fetcher, followOnlyOptions);
  return data?.openingLab === true;
}
