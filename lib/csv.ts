/**
 * lib/csv.ts
 *
 * RFC 4180 CSV serialization primitives. The single source of truth for
 * building CSV responses (admin usage export, corpus export, …) so the
 * escaping rules live in exactly one place.
 *
 * Output uses CRLF row terminators and a trailing CRLF, per RFC 4180 — the
 * form Excel and the BnF's tooling expect.
 */

/** Escape a single CSV cell value (RFC 4180). */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ""
  const str = String(value)
  // Wrap in quotes if the value contains a comma, newline, CR, or double-quote.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/** Join one row of already-typed cells into a CSV line (no terminator). */
export function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvCell).join(",")
}

/**
 * Build a complete CSV document from a header row and body rows. Terminates
 * every row (including the last) with CRLF.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (string | number | boolean | null | undefined)[][],
): string {
  const lines = [csvRow([...header]), ...rows.map(csvRow)]
  return lines.join("\r\n") + "\r\n"
}
