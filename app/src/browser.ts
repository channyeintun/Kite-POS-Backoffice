//! What the two apps need from the browser, in one place.
//!
//! Storage, the address bar, timers, the wall clock and the calendar, the parts
//! of a page a till touches, a receipt printed by printing the page, and the
//! two transfers that carry a credential.
//!
//! The wrappers here are here for one reason each, and it is always the same
//! reason: the browser can refuse, and **this application's answer is to write
//! it down and carry on**. A till with a queue at it does not stop because a
//! browser refused to remember something. That decision belongs in one place
//! rather than at each of the twenty call sites.

import { clamp, div, pad_start, parse_int, trim } from "./lang.ts";

// ---- the clock ---------------------------------------------------------------
//
// **The API speaks seconds and the browser speaks milliseconds**, so the
// conversion lives here rather than being remembered at each call site.
//
// Every reading below is rendered in the device's own zone, which is the
// shop's, taken from the device's offset *now* and applied to every instant —
// so the reports agree with the screen about which day it is. They did not
// once: an ISO day read in UTC while `day_of` and `clock_of` read local fields
// filed a sale rung after seven in the evening in Yangon under the next day.

/** Minutes east of UTC, as the device believes them. */
function here(): number {
  try {
    const minutes = new Date().getTimezoneOffset();
    return minutes === 0 ? 0 : -Math.trunc(minutes);
  } catch {
    return 0;
  }
}

/** Seconds since the epoch, which is the unit the API speaks in. */
export function now(): number {
  return div(Date.now(), 1000);
}

interface Civil {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function floor_div(a: number, b: number): number {
  const q = div(a, b);
  if (a % b !== 0 && a < 0 !== b < 0) {
    return q - 1;
  }
  return q;
}

function days_of_date(year: number, month: number, day: number): number {
  // A month outside 1..12 is carried into the year rather than refused, so
  // `month + 1` on December is January of the next year.
  const carry = floor_div(month - 1, 12);
  const y_in = year + carry;
  const m = month - carry * 12;
  const y = m <= 2 ? y_in - 1 : y_in;
  const era = y >= 0 ? div(y, 400) : div(y - 399, 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = div(153 * mp + 2, 5) + day - 1;
  const doe = yoe * 365 + div(yoe, 4) - div(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

function date_of_days(count: number): Civil {
  const z = count + 719468;
  const era = z >= 0 ? div(z, 146097) : div(z - 146096, 146097);
  const doe = z - era * 146097;
  const yoe = div(doe - div(doe, 1460) + div(doe, 36524) - div(doe, 146096), 365);
  const doy = doe - (365 * yoe + div(yoe, 4) - div(yoe, 100));
  const mp = div(5 * doy + 2, 153);
  const d = doy - div(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400;
  const year = m <= 2 ? y + 1 : y;
  return { year, month: m, day: d, hour: 0, minute: 0, second: 0 };
}

/** The calendar fields of an instant, in a zone `east_minutes` east of UTC. */
function civil_of(ms: number, east_minutes: number): Civil {
  const local = ms + east_minutes * 60000;
  // Floored, not truncated: an instant before 1970 still belongs to the day
  // it fell in.
  const days = floor_div(local, 86400000);
  const rest = local - days * 86400000;
  const date = date_of_days(days);
  return {
    year: date.year,
    month: date.month,
    day: date.day,
    hour: div(rest, 3600000),
    minute: div(rest % 3600000, 60000),
    second: div(rest % 60000, 1000),
  };
}

function epoch_of(c: Civil, east_minutes: number): number {
  const days = days_of_date(c.year, c.month, c.day);
  const local = days * 86400000 + c.hour * 3600000 + c.minute * 60000 + c.second * 1000;
  return local - east_minutes * 60000;
}

function pad2(n: number): string {
  if (n < 10) {
    return `0${n}`;
  }
  return `${n}`;
}

function pad4(n: number): string {
  if (n < 0) {
    return "-" + pad_start(`${0 - n}`, 4, "0");
  }
  return pad_start(`${n}`, 4, "0");
}

/** `hh:mm` in the shop's own timezone. */
export function clock_of(epoch: number): string {
  const c = civil_of(epoch * 1000, here());
  return `${pad2(c.hour)}:${pad2(c.minute)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `dd Mon`, for a status bar that has no room for a year.
 *
 * The month names are English whatever the chrome is set to, exactly as the
 * digits are Latin: a date is data, not chrome.
 */
export function day_of(epoch: number): string {
  const at = civil_of(epoch * 1000, here());
  return `${at.day} ${MONTHS[clamp(at.month - 1, 0, 11)]}`;
}

/**
 * A date the operator has to check an ID against, spelled out.
 *
 * The dialog shows the minimum age *and this*, so nobody is doing arithmetic
 * at the counter with a queue waiting.
 */
export function date_of(epoch: number): string {
  return `${day_of(epoch)} ${civil_of(epoch * 1000, here()).year}`;
}

/**
 * `YYYY-MM-DD`, which is what a filename wants.
 *
 * `date_of` writes "10 Jul 2026" for a person to read; a folder of files
 * named that way sorts April before January. A saved report is filed and
 * found again months later, so its name sorts in the only order that is
 * unambiguous in every locale.
 */
export function iso_day(epoch: number): string {
  const c = civil_of(epoch * 1000, here());
  return `${pad4(c.year)}-${pad2(c.month)}-${pad2(c.day)}`;
}

/** The first and last second of a month written `2026-08`. */
export function month_bounds(month: string): number[] {
  const parts = trim(month).split("-");
  if (parts.length !== 2) {
    return [];
  }
  const year = parse_int(parts[0]);
  const index = parse_int(parts[1]);
  if (year === null) {
    return [];
  }
  if (index === null) {
    return [];
  }
  if (index < 1 || index > 12) {
    return [];
  }
  const start = (y: number, m: number) =>
    epoch_of({ year: y, month: m, day: 1, hour: 0, minute: 0, second: 0 }, here());
  return [div(start(year, index), 1000), div(start(year, index + 1) - 1, 1000)];
}

// ---- listeners and timers ------------------------------------------------------

/** Listen to the window, and let the page carry on if it refuses. */
export function on_window(name: string, handler: () => void): void {
  try {
    window.addEventListener(name, () => handler());
  } catch (e) {
    console.error(`browser: no ${name} listener: ${message_of(e)}`);
  }
}

/**
 * Run something on a fixed interval, for the heartbeat that keeps a lane's
 * "last seen" honest in the back office.
 *
 * The timer is dropped rather than kept, because this one runs for as long as
 * the page does — there is no moment at which the back office stops wanting
 * to know which lanes are awake.
 */
export function every(ms: number, handler: () => void): void {
  try {
    window.setInterval(() => handler(), ms);
  } catch (e) {
    console.error(`browser: could not set an interval: ${message_of(e)}`);
  }
}

// ---- remembering, and where we are ---------------------------------------------
//
// Reading answers `null` for anything the browser will not give back. Writing
// can fail, and none of these is worth a failed sale.

export function kept(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function keep(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    console.error(`browser: could not keep ${key}`);
  }
}

export function drop_kept(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    console.error(`browser: could not drop ${key}`);
  }
}

export function hash(): string {
  return window.location.hash;
}

export function set_hash(fragment: string): void {
  try {
    window.location.hash = fragment;
  } catch {
    console.error("browser: could not navigate");
  }
}

/** A value made safe to put in a query string. */
export function escaped(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The browser's own print dialog.
 *
 * A receipt is printed by printing the page: `@media print` in the stylesheet
 * drops the rail, the header and every card except the receipt itself, so
 * there is nothing here to build.
 */
export function print_page(): void {
  try {
    window.print();
  } catch {
    console.error("browser: could not print");
  }
}

/** Ask the browser to install the service worker. */
export function register_worker(path: string): void {
  const workers = navigator.serviceWorker;
  if (workers === undefined || workers === null) {
    console.error("browser: no service worker: this browser has no service workers");
    return;
  }
  workers.register(path).catch((e: unknown) => {
    console.error(`browser: no service worker: ${message_of(e)}`);
  });
}

// ---- the page a till touches -----------------------------------------------------

export function focus(selector: string): void {
  const target = document.querySelector<HTMLElement>(selector);
  if (target === null) {
    return;
  }
  target.focus();
}

/** What a field holds, trimmed, or "" when there is no such field. */
export function field_value(selector: string): string {
  const field = document.querySelector<HTMLInputElement>(selector);
  if (field === null) {
    return "";
  }
  return trim(field.value ?? "");
}

/**
 * Whether a keystroke is the operator typing rather than a shortcut.
 *
 * A barcode scanner sends bare characters. ⌘R and Ctrl-F are the browser's,
 * and routing them into the scan box would both swallow them and fill the box
 * with letters nobody typed.
 */
export function plain_key(e: KeyboardEvent): boolean {
  if (e.ctrlKey) {
    return false;
  }
  if (e.metaKey) {
    return false;
  }
  return !e.altKey;
}

/**
 * Empty a field and leave the focus where the operator put it.
 *
 * For the scan box after a barcode lands: the box has to be empty and ready
 * for the next one, and pulling the caret back out of whatever the operator
 * tapped in between is the thing this till used to do — on every repaint,
 * which is every tap.
 */
export function clear_field(selector: string): void {
  const target = document.querySelector<HTMLInputElement>(selector);
  if (target === null) {
    return;
  }
  target.value = "";
}

/**
 * Add to what a field already holds, without touching the focus.
 *
 * Where a scanner's characters go when the caret is somewhere else. One
 * character at a time, so the box fills exactly as it would have if it had
 * been focused all along — and the operator's own tap keeps the focus it
 * earned.
 */
export function append_value(selector: string, suffix: string): void {
  const target = document.querySelector<HTMLInputElement>(selector);
  if (target === null) {
    return;
  }
  target.value = target.value + suffix;
}

/**
 * A `<meta name="…" content="…">` from the page, or "".
 *
 * How a deployment tells the program where its API is without a rebuild: the
 * same `dist/` is a test shop or a real one depending on one line of HTML.
 */
export function meta(name: string): string {
  const tag = document.querySelector(`meta[name="${name}"]`);
  if (tag === null) {
    return "";
  }
  return tag.getAttribute("content") ?? "";
}

/**
 * The document's own `lang`.
 *
 * Not decoration: the stylesheet keys Burmese's taller line box off it, so
 * this is the one write that makes မြန်မာ legible rather than cramped. One
 * attribute rather than a class on every string.
 */
export function set_document_lang(tag: string): void {
  try {
    document.documentElement.lang = tag;
  } catch {
    console.error("browser: could not set the document language");
  }
}

// ---- saving a file ---------------------------------------------------------

/**
 * Hand the operator a file.
 *
 * An export cannot be a plain link: the Worker wants an `Authorization`
 * header, and a link carries none — and putting the token in the query string
 * instead would write a credential into the browser's history and every log
 * between here and there. So the body is fetched with the header, turned into
 * a blob, and saved through an anchor that is created, clicked and thrown
 * away.
 *
 * **The byte-order mark is added here**, and that is not belt-and-braces: the
 * Worker puts one at the front of every CSV, and the `fetch` that brought it
 * back stripped it while decoding, because that is what a UTF-8 decoder is
 * specified to do. Re-encoding without it would hand Excel on Windows a file
 * it reads in the system code page — which turns every Burmese character in
 * it into mojibake. It goes in as its own blob part, so no string in this
 * program has to carry an invisible character.
 */
export function download(filename: string, body: string, mime: string): void {
  let url: string;
  try {
    const blob = new Blob([String.fromCharCode(65279), body], { type: mime });
    url = URL.createObjectURL(blob);
  } catch {
    console.error("browser: this browser cannot make a file");
    return;
  }
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  try {
    link.click();
  } catch {
    console.error("browser: could not save the file");
  }
  // The object URL holds the whole file in memory until it is let go.
  try {
    URL.revokeObjectURL(url);
  } catch {
    console.error("browser: could not release the file");
  }
}

// ---- pictures --------------------------------------------------------------

/**
 * Send the picture a file input is holding, and answer with its key.
 *
 * **Not through `api.ts`.** The API's requests carry text, and an image is
 * bytes — re-encoding one as text to get it through that door would double its
 * size and corrupt it. So this is `fetch` with the `File` handed over
 * untouched, which is also what lets the browser stream it rather than holding
 * a copy.
 *
 * The content type comes off the file itself, because that is what the Worker
 * keys its allow-list on — and what R2 will serve it back as.
 */
export function upload_photo(
  url: string,
  token: string,
  input: HTMLInputElement,
  done: (key: string) => void,
  failed: (why: string) => void,
): void {
  const files = input.files;
  if (files === null) {
    failed("that input has no file");
    return;
  }
  if (files.length === 0) {
    failed("nothing was chosen");
    return;
  }
  const file = files[0];
  const init: RequestInit = {
    method: "PUT",
    body: file,
    headers: {
      "content-type": typeof file.type === "string" ? file.type : "application/octet-stream",
      authorization: `Bearer ${token}`,
    },
  };
  let promise: Promise<Response>;
  try {
    promise = window.fetch(url, init);
  } catch {
    failed("the request did not go out");
    return;
  }
  promise.then(
    (response) => photo_answered(response, done, failed),
    (why: unknown) => failed(rejection(why)),
  );
}

/**
 * The response to an upload: refuse a non-2xx, then read the key out of the
 * body.
 */
function photo_answered(response: Response, done: (key: string) => void, failed: (why: string) => void): void {
  if (!response.ok) {
    const status = response.status;
    if (status === 413 || status === 400) {
      failed("that picture was refused — keep it under 2 MB, as a JPEG, PNG or WebP");
    } else {
      failed(`that picture could not be saved (${status})`);
    }
    return;
  }
  let body: Promise<unknown>;
  try {
    body = response.json();
  } catch {
    failed("that answer could not be read");
    return;
  }
  body.then(
    (parsed) => {
      const key =
        typeof parsed === "object" && parsed !== null && typeof (parsed as { key?: unknown }).key === "string"
          ? (parsed as { key: string }).key
          : "";
      done(key);
    },
    (why: unknown) => failed(rejection(why)),
  );
}

/** A promise's refusal, in words. */
function rejection(reason: unknown): string {
  if (typeof reason === "string") {
    return reason;
  }
  const detail =
    typeof reason === "object" && reason !== null && typeof (reason as { message?: unknown }).message === "string"
      ? (reason as { message: string }).message
      : "";
  if (detail.length > 0) {
    return detail;
  }
  return `the host rejected with a ${reason === null ? "null" : typeof reason}`;
}

function message_of(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
