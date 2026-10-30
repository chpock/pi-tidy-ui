export function preparedCardReady(consumer: object, owner: object, palettePrefix?: string): boolean;
export function preparedHistoryReady(consumer: object, expectedIds: Set<string>, palettePrefix?: string): boolean;
export function preparedHistoryPaintOriginCount(consumer: object, expectedIds: Set<string>, origin: string): number;
export function explainPreparedHistory(consumer: object, expectedIds: Set<string>): unknown;
