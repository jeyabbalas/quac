import { mountSchemaSlotCard } from './schema/schemaSlotCard';

/** Load view: the three input slot cards (dataset P05 · schema P06 · rules P12). */
export function mountLoadView(container: HTMLElement): void {
  const row = document.createElement('div');
  row.className = 'q-slot-row';
  container.append(row);
  // P05: dataset slot card mounts FIRST in this row (wireframe order).
  mountSchemaSlotCard(row);
  // P12: rules slot card mounts last in this row.
}
