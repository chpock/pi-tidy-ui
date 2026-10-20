export function preparedCardReady(consumer: object, owner: object, profile?: string): boolean;
export function preparedHistoryReady(consumer: object, expectedIds: Set<string>, profile?: string): boolean;
export function explainPreparedHistory(consumer: object, expectedIds: Set<string>): unknown;
