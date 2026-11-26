import type { BashService, PreparedBashRegions, PreparedRegion } from '../rendering/card-values.ts';
import type { CardMeasurements } from './preparation.ts';

export function prepareCommand(text: string, previous: PreparedRegion | undefined, measurements: CardMeasurements): PreparedRegion {
  if (previous?.text === text) return previous;
  if (previous && text.startsWith(previous.text)) return measurements.append(previous, text);
  return measurements.region(text);
}

export function prepareBashRegions(service: BashService, expanded: boolean, previous: PreparedBashRegions | undefined,
  measurements: Pick<CardMeasurements, 'region'>): PreparedBashRegions {
  const serviceRegion = (text: string, prior?: PreparedRegion) => prior?.text === text ? prior : measurements.region(text);
  // Every logical row contributes at least one visual row. Each collapsed
  // section therefore needs at most eleven logical rows, at every width.
  // Keep complete service text; expansion prepares missing rows before render.
  const outputEnd = expanded ? service.last : Math.min(service.last, service.first + 11);
  const reminderEnd = expanded ? service.end : Math.min(service.end, service.reminder + 11);
  return Object.freeze({
    description: service.description ? serviceRegion(`# ${service.description}`, previous?.description) : undefined,
    heading: service.heading ? serviceRegion(service.heading, previous?.heading) : undefined,
    output: Object.freeze(service.output.map((text, index) => text && (index >= service.first && index < outputEnd || index >= service.reminder && index < reminderEnd)
      ? serviceRegion(text, previous?.output[index]) : undefined)),
    notice: service.notice ? serviceRegion(service.notice, previous?.notice) : undefined,
    footer: service.footer ? serviceRegion(service.footer, previous?.footer) : undefined,
  });
}
