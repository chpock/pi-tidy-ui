export interface PaletteInputObservation {
  opens: number;
  reads: number;
  ownerLookups: number;
}

export function observePaletteInput(id: string): {
  snapshot(): PaletteInputObservation;
  restore(): void;
};
