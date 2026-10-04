export type SwitchResult = boolean | { cancelled: boolean } | null | undefined;
export function normalizeSwitchResult(result: SwitchResult): { cancelled: boolean };
