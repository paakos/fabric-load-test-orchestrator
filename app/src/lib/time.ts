/** Fabric returns UTC timestamps without a zone (`2026-11-27T12:13:05.1234567`): JavaScript would read them as local time. */
export const parseUtc = (s?: string): number => (s ? Date.parse(/Z$|GMT$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : NaN);
