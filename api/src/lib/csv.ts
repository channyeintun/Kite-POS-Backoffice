import type { Currency } from "./money.js";

/**
 * Writing a sheet somebody else's software has to read.
 *
 * An export is the one place in this system where the *reader* is not us. A
 * shopkeeper hands the file to an accountant, who opens it in Excel or
 * LibreOffice on a Windows machine, and every decision here is about that
 * moment rather than about how the figure looks on our own screen.
 *
 * Three of them are worth stating, because each is a way an export quietly
 * becomes useless:
 *
 * **Amounts carry no separators and no symbol.** `formatAmount` writes
 * "K1,234" because that is what a person reads. A spreadsheet reads it as text,
 * and a column of text does not add up — so the total the accountant needs is
 * the one thing they cannot get. `plainAmount` writes `1234` or `-1234.56`, and
 * the file is arithmetic again.
 *
 * **Dates are ISO 8601, not the shop's format.** `9 Aug 2026` sorts
 * alphabetically, which puts April first. `2026-08-09` sorts correctly in every
 * locale and parses in every tool.
 *
 * **The file starts with a byte-order mark.** Excel on Windows opens a UTF-8
 * file without one as the system code page, which turns every Burmese
 * character in it into mojibake. This shop ships Burmese; the BOM is three
 * bytes and it is the difference between a readable file and a broken one.
 */

/** One row, RFC 4180. A field is quoted only when it has to be. */
export function csvRow(fields: readonly string[]): string {
  return fields
    .map((f) => (/[",\r\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f))
    .join(",");
}

/** CRLF between rows, which is what RFC 4180 says and what Excel expects. */
export function csvDoc(rows: readonly (readonly string[])[]): string {
  return rows.map(csvRow).join("\r\n");
}

/**
 * An amount as a machine reads it: an optional `-`, digits, and exactly as many
 * decimal places as the currency has. No grouping, no symbol.
 *
 * The minor units are integers all the way through this system, so this is a
 * digit insertion rather than a division — `1234` with two minor units is
 * "12.34", and no float is involved in getting there.
 */
export function plainAmount(value: number, c: Currency): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(value)));
  if (c.minorUnits <= 0) return sign + digits;
  const padded = digits.padStart(c.minorUnits + 1, "0");
  const cut = padded.length - c.minorUnits;
  return `${sign}${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

/** A whole number — a count, a quantity of something countable. */
export function plainNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

/** `YYYY-MM-DD`, from epoch seconds. */
export function isoDay(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

/** Full ISO 8601 with the time, for a column where the hour matters. */
export function isoStamp(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace(".000", "");
}

/**
 * The preamble every sheet opens with: what it is and what window it covers,
 * then a blank row.
 *
 * In ISO rather than the shop's own wording, so a script can read the range
 * back off the file. Without it a folder of exports is a folder of files nobody
 * can tell apart.
 */
export function preamble(report: string, from: number, to: number): string[][] {
  return [["Report", report, "From", isoDay(from), "To", isoDay(to)], []];
}

/** Only what is safe in a `filename=` parameter, so the header cannot be broken. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "export.csv";
}

/**
 * The download itself.
 *
 * `no-store` because a report is a point in time: a browser that serves a
 * cached copy of yesterday's trial balance is worse than one that refuses.
 */
export function csvResponse(filename: string, body: string): Response {
  // Written as an escape, not as a literal character: an invisible byte at the
  // top of a source file is one an editor, a formatter or a copy-paste can
  // remove without anybody seeing it go.
  return new Response(`\uFEFF${body}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${safeName(filename)}"`,
      "cache-control": "no-store",
    },
  });
}
