/**
 * Tiny 5-field cron matcher: minute, hour, day-of-month, month, day-of-week.
 * Supports `*`, steps, comma lists, ranges and range+step, plus the usual
 * `@daily` style aliases. Enough for "every weekday at 07:30" automations
 * without pulling in a scheduler library.
 */
const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week, 0 = Sunday
];

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export type CronFields = ReadonlyArray<ReadonlySet<number>>;

export function parseCron(expr: string): CronFields {
  const normalized = ALIASES[expr.trim().toLowerCase()] ?? expr;
  const parts = normalized.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression needs 5 fields, got ${parts.length}: "${expr}"`);
  }
  return parts.map((part, i) => {
    const range = FIELD_RANGES[i];
    if (!range) throw new Error('unreachable cron field index');
    return parseField(part, range[0], range[1], i);
  });
}

function parseField(field: string, min: number, max: number, index: number): Set<number> {
  const values = new Set<number>();
  for (const chunk of field.split(',')) {
    const [rangePart, stepPart] = chunk.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step in "${field}"`);

    let lo = min;
    let hi = max;
    if (rangePart && rangePart !== '*') {
      const bounds = rangePart.split('-');
      const first = tokenToNumber(bounds[0] ?? '', index);
      lo = first;
      if (bounds.length > 1) {
        hi = tokenToNumber(bounds[1] ?? '', index);
      } else {
        // "5" is a single value; "5/2" means "from 5 to the end of the range".
        hi = stepPart === undefined ? first : max;
      }
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field out of range: "${field}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (index === 4 && values.has(7)) values.add(0); // 0 and 7 are both Sunday
  return values;
}

function tokenToNumber(token: string, index: number): number {
  const t = token.trim().toLowerCase();
  if (t === '') throw new Error('empty cron token');
  if (index === 4) {
    const dow = DOW_NAMES.indexOf(t.slice(0, 3));
    if (dow >= 0) return dow;
    if (t === '7') return 0;
  }
  if (index === 3) {
    const mon = MONTH_NAMES.indexOf(t.slice(0, 3));
    if (mon >= 0) return mon + 1;
  }
  const n = Number(t);
  if (!Number.isInteger(n)) throw new Error(`bad cron token "${token}"`);
  return n;
}

export function cronMatches(fields: CronFields, date: Date): boolean {
  const [minute, hour, dom, month, dow] = fields;
  if (!minute || !hour || !dom || !month || !dow) return false;
  if (!minute.has(date.getMinutes())) return false;
  if (!hour.has(date.getHours())) return false;
  if (!month.has(date.getMonth() + 1)) return false;

  // Standard cron quirk: when both day fields are restricted either may match.
  const domRestricted = dom.size !== 31;
  const dowRestricted = dow.size < 7;
  const domOk = dom.has(date.getDate());
  const dowOk = dow.has(date.getDay());
  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}
