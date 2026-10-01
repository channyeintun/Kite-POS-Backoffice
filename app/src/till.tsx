//! The till, drawn.
//!
//! Every component here is a **pure function of the store**. Nothing in this
//! file listens for anything of its own, starts a request or keeps state — React
//! compares the new tree against the last one and changes only what differs,
//! and `pos.tsx` holds the two ends.
//!
//! One exception, and it is about time rather than about the sale: a dialog
//! the store has closed stays on the screen for the 180 ms it takes to go —
//! see `Overlay`. It is inert for those milliseconds, so it can be seen
//! leaving and cannot be touched.
//!
//! **Every control says what it means in a `data-action`**, and every one of
//! them hands the same `press` handler to `onClick`. The handler reads the
//! action and its `data-id` off the element that was touched and `pos.tsx`
//! decides what it means, in one table — so the markup says *what* an element
//! is and never *how* it behaves.
//!
//! ## The four regions
//!
//! Every screen is the same four regions in the same order of authority, and
//! they never reorder between viewports — they resize, demote to icons, or
//! become a tab:
//!
//! | | |
//! |---|---|
//! | **ledger** | what the customer is buying. Never scrolls away. |
//! | **work area** | how items get in. The only region that changes by mode. |
//! | **commands** | what else the operator can do. Locked, never hidden. |
//! | **status** | lane health only. Store, register, operator, connection, date. |
//!
//! What is never traded away, at any size: the running total is visible in
//! every viewport and every mode; the commit button is pinned and never
//! scrolls; the scan field never loses focus; a restricted command is shown
//! locked rather than hidden; and the connection state is on screen at all
//! times, because this till is online and that dot is load-bearing.

import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import * as store from "./store.ts";
import type { App } from "./store.ts";
import * as model from "./model.ts";
import * as money from "./money.ts";
import * as i18n from "./i18n.ts";
import * as browser from "./browser.ts";
import { div, int_text, round_to } from "./lang.ts";

/** What every control's `onClick` is: one handler, reading the element. */
export type Press = (e: MouseEvent<HTMLElement>) => void;

interface Props {
  app: App;
  press: Press;
}

function t(app: App, key: string): string {
  return i18n.t(app.lang, key);
}

function amount(app: App, value: number): string {
  return money.show(value, store.currency_of(app));
}

/** A `type="button"` button with its classes, its label and what it means. */
function Button({
  label,
  classes,
  action,
  id,
  press,
  lang,
  purpose,
  pid,
  amount: data_amount,
}: {
  label: string;
  classes: string;
  action: string;
  id?: string;
  press: Press;
  lang?: string;
  purpose?: string;
  pid?: string;
  amount?: string;
}): ReactElement {
  return (
    <button
      className={classes}
      type="button"
      data-action={action}
      data-id={id}
      data-purpose={purpose}
      data-pid={pid}
      data-amount={data_amount}
      lang={lang}
      onClick={press}
    >
      {label}
    </button>
  );
}

// ---- status ----------------------------------------------------------------

/**
 * Lane health, and nothing else.
 *
 * Never customer or product content — this bar answers "can this lane
 * transact", and mixing a customer's name into it is how it stops being read.
 * Colour here carries machine state and only machine state.
 */
function StatusBar({ app, press }: Props): ReactElement {
  const session = app.session;
  const name = session === null ? "" : session.name;
  const shop = session === null ? "" : session.shop_name;
  const lane = session === null ? "" : session.register_name;

  return (
    <header className="status">
      <span className={app.mode === "Sale" ? "mode sale" : "mode tender"}>
        {app.mode === "Sale" ? t(app, "sale") : t(app, "tender")}
      </span>
      <span className="shop">{shop}</span>
      {/* `register`, not `lane`: `main.lane` is the layout container for the
          four regions, and a bare `.lane` rule written for it also matched
          this span and stretched the register ID across the status bar. */}
      <span className="register">{lane}</span>
      <span className={app.basket.shift_open ? "shift" : "shift shut"}>
        {app.basket.shift_open ? t(app, "shift_open") : t(app, "no_shift")}
      </span>
      <span className="gap" />
      <span className="status-right">
        <span className={app.online ? "dot online" : "dot offline"}>
          {app.online ? t(app, "online") : t(app, "offline")}
        </span>
        {/* Deliberately small — 44 px, below the transaction target scale and
            outside the scan-to-pay path. Switching language mid-basket is a
            mistake rather than a workflow, so it is reachable but not on the
            way anywhere. */}
        <span className="lang">
          <Button label="EN" classes={app.lang === "En" ? "lang-on" : "lang-off"} action="lang-en" press={press} />
          {/* Its own `lang`, because the page's may be `en`: a Burmese label
              needs the Burmese face and the taller line box whatever the
              chrome is set to. */}
          <Button
            label="မြန်မာ"
            classes={app.lang === "My" ? "lang-on" : "lang-off"}
            action="lang-my"
            lang="my"
            press={press}
          />
        </span>
        {/* The operator's name *is* the way out. The back office signs out
            from the same place — the person's own name at the edge of the
            chrome. */}
        <button className="who" type="button" title={t(app, "sign_out")} data-action="sign-out" onClick={press}>
          <span className="who-name">{name}</span>
          <span className="who-out">{t(app, "sign_out")}</span>
        </button>
        <span className="when">{browser.day_of(browser.now())}</span>
      </span>
    </header>
  );
}

// ---- the ledger ------------------------------------------------------------

/**
 * One line of the transaction.
 *
 * The secondary line — unit price, the offer that priced it, an age flag — is
 * the first thing to go when the screen narrows, and the quantity, the name
 * and the amount are what stay. That ordering is the responsive rule written
 * as markup rather than as a breakpoint.
 */
function LedgerRow({ app, press, line }: Props & { line: model.Line }): ReactElement {
  return (
    <li className="row" data-action="line" data-id={line.id} onClick={press}>
      <span className="qty">{money.quantity(line.qty)}</span>
      <span className="line-body">
        <span className="name">{model.line_label(line, app.lang)}</span>
        <span className="detail">
          {line.promo_name.length > 0 && <span className="promo">{line.promo_name}</span>}
          {line.min_age > 0 && (
            <span className={line.age_checked ? "age ok" : "age"}>
              {`AGE ${line.min_age}${line.age_checked ? " ✓" : ""}`}
            </span>
          )}
          {line.price_override && <span className="override">{t(app, "price_override")}</span>}
          <span className="unit">{`${amount(app, line.unit_price)} ${t(app, "each")}`}</span>
          {line.line_discount > 0 && <span className="promo">{`− ${amount(app, line.line_discount)}`}</span>}
        </span>
      </span>
      <span className="amount">
        {/* The struck-through shelf price, beside what is actually being
            charged. */}
        {line.promo_saved > 0 && <span className="was">{amount(app, line.total + line.promo_saved)}</span>}
        <span className="now">{amount(app, line.total)}</span>
      </span>
    </li>
  );
}

function TotalsBlock({ app }: { app: App }): ReactElement {
  const totals = app.basket.totals;
  return (
    <div className="totals">
      <div className="tot">
        <span>{t(app, "subtotal")}</span>
        <span>{amount(app, totals.subtotal)}</span>
      </div>
      {(totals.promo_saved > 0 || totals.discount > 0) && (
        <div className="tot saved">
          <span>{t(app, "promotions_saved")}</span>
          <span>{`−${amount(app, totals.promo_saved + totals.discount)}`}</span>
        </div>
      )}
      {totals.tax > 0 && (
        <div className="tot">
          <span>{t(app, "tax_included")}</span>
          <span>{amount(app, totals.tax)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The ledger: lines, totals, and the commit button.
 *
 * The total is the largest type on the screen and the commit button lives with
 * it rather than with the commands — it is the end of the transaction, not
 * another thing the operator might do.
 */
function Ledger({ app, press }: Props): ReactElement {
  const locked = app.mode === "Tender";
  return (
    <section className="ledger">
      <div className="ledger-head">
        <span className="region">{t(app, "ledger")}</span>
        <span className="count">
          {`${money.quantity(app.basket.totals.item_count)} ${t(app, "items")}${locked ? " · locked" : ""}`}
        </span>
        {app.basket.customer_name.length > 0 && (
          <span className="customer">{`${app.basket.customer_name} · ${app.basket.customer_points} pts`}</span>
        )}
      </div>
      <div className="ledger-body">
        {app.basket.lines.length === 0 ? (
          <p key="empty" className="empty">
            {t(app, "empty_basket")}
          </p>
        ) : (
          <ul key="rows" className="rows">
            {app.basket.lines.map((l) => (
              <LedgerRow key={l.id} app={app} press={press} line={l} />
            ))}
          </ul>
        )}
      </div>
      <div className="ledger-foot">
        <TotalsBlock app={app} />
        <div className="grand">
          <span className="grand-label">{t(app, "total")}</span>
          <span className="grand-value">{amount(app, app.basket.totals.total)}</span>
        </div>
        {/* **In tender mode the running total belongs here, beside the basket
            it is the total of.** What has been taken, what is still due and
            the two buttons that end the sale are all *about the basket*, and
            putting them in the work column left the numeric surface sharing a
            fixed height with them — four rows of 20 mm keys plus a tender
            chooser plus a summary do not fit, so the pad scrolled and the `0`
            key, the one every kyat price ends in, was below the fold. */}
        {locked ? (
          <TenderSummary key="tender-summary" app={app} press={press} />
        ) : (
          // Pinned, and it never scrolls. 118 px is 20 mm at this reference
          // density — the kiosk minimum from Colle & Hiszem. Two spans rather
          // than one string: in portrait the commit is a full-width bar across
          // the bottom edge, and the design puts the word at the left and the
          // amount at the right.
          <button
            key="pay"
            className={app.basket.lines.length === 0 ? "commit off" : "commit"}
            type="button"
            data-action="pay"
            onClick={press}
          >
            <span className="commit-word">{t(app, "pay")}</span>
            <span className="commit-sum">{amount(app, app.basket.totals.total)}</span>
          </button>
        )}
      </div>
    </section>
  );
}

// ---- the work area ---------------------------------------------------------

/** Where the Worker is, for an image `src`. */
function api_base(): string {
  const kept = browser.meta("api-base");
  if (kept.length > 0) {
    return kept;
  }
  return "/api";
}

function Tile({ app, press, p }: Props & { p: model.Product }): ReactElement {
  return (
    <button className="tile" type="button" data-action="tile" data-id={p.id} onClick={press}>
      {/* The picture, or the grey field that stands in for one. An `<img>`
          with no `src` draws a broken-image glyph, so a product without a
          photo gets a plain box instead — which is also what the grid looked
          like before there were any. */}
      {p.photo_key.length > 0 ? (
        <img key="photo-img" className="tile-photo" src={`${api_base()}/photos/${p.photo_key}`} alt="" loading="lazy" />
      ) : (
        <span key="photo-box" className="tile-photo" />
      )}
      <span className="tile-name">{store.product_label(p, app.lang)}</span>
      <span className="tile-price">{amount(app, p.price)}</span>
      <span className="tile-marks">
        {p.min_age > 0 && <span className="tile-age">{`${p.min_age}+`}</span>}
        {p.ask_price && <span className="tile-ask">ASK PRICE</span>}
        {p.stock <= 0.0 && <span className="tile-out">OUT</span>}
      </span>
    </button>
  );
}

function Tabs({ app, press }: Props): ReactElement {
  return (
    <div className="tabs">
      <Button
        label={t(app, "favourites")}
        classes={app.tab.length === 0 ? "tab on" : "tab"}
        action="tab"
        id=""
        press={press}
      />
      {app.categories.map((c) => (
        <Button
          key={c.id}
          label={model.category_label(c, app.lang)}
          classes={app.tab === c.id ? "tab on" : "tab"}
          action="tab"
          id={c.id}
          press={press}
        />
      ))}
    </div>
  );
}

/**
 * Sale mode: the scan field owns the top.
 *
 * A barcode scanner is a fast keyboard, so anything typed anywhere has to land
 * here — `pos.tsx` listens on the document and writes a scanner's burst into
 * this box whatever holds the focus.
 */
function WorkSale({ app, press }: Props): ReactElement {
  return (
    <section className="work">
      <div className="scan">
        <span className="region">{t(app, "scan")}</span>
        <input id="scan" className="scan-field" type="text" autoComplete="off" placeholder={t(app, "scan_hint")} />
        <Button label={t(app, "search")} classes="chip" action="search" press={press} />
        <Button label={t(app, "keypad")} classes="chip" action="keypad" press={press} />
      </div>
      <Tabs app={app} press={press} />
      <Shelf app={app} press={press} />
    </section>
  );
}

/**
 * The tiles on the tab that is open, or a sentence saying there are none.
 *
 * An empty shelf used to be an empty rectangle — most of a portrait screen
 * with nothing in it and nothing to say why, which reads as broken. A shop
 * with no quick keys set up yet is the ordinary first morning, so the lane
 * says what to do instead: the scan box above still rings anything.
 */
function Shelf({ app, press }: Props): ReactElement {
  const tiles = store.tiles(app);
  if (tiles.length === 0) {
    return (
      <p key="shelf-empty" className="shelf-empty">
        {t(app, "no_tiles")}
      </p>
    );
  }
  return (
    <div key="grid" className="grid">
      {tiles.map((p) => (
        <Tile key={p.id} app={app} press={press} p={p} />
      ))}
    </div>
  );
}

// ---- tender ----------------------------------------------------------------

function TenderButton({ app, press, tender, name }: Props & { tender: model.Tender; name: string }): ReactElement {
  return (
    <Button
      label={t(app, name)}
      classes={app.tender === tender ? "tender on" : "tender"}
      action="tender"
      id={model.tender_code(tender)}
      press={press}
    />
  );
}

/**
 * The numeric surface.
 *
 * Keys are 118 × 118 px — 20 mm at this reference density, the size Colle &
 * Hiszem found sufficient at a standing kiosk, where 25 mm tested no better.
 * Gaps are 8 px because spacing had no measurable effect in that study, so the
 * screen budget goes into the targets. That is also why Clear and 000 sit in a
 * column beside the digits rather than stealing a row from them.
 *
 * **Emitted row by row, not column by column.** The grid is four columns
 * wide, so the order the keys are pushed in *is* the order they are read in —
 * `1 2 3 ⌫ / 4 5 6 Clear / 7 8 9 000`, then `0` alone, which the stylesheet
 * widens across the digit columns. A cashier's hand knows where 7 is without
 * looking.
 */
function Keypad({ app, press, suffix }: Props & { suffix: string }): ReactElement {
  const keys: ReactNode[] = [];
  const rows: string[][] = [
    ["1", "2", "3", "back"],
    ["4", "5", "6", "clear"],
    ["7", "8", "9", "000"],
  ];
  for (const row of rows) {
    for (const k of row) {
      if (k === "back") {
        keys.push(<Button key={`back${suffix}`} label="⌫" classes="key util" action="key" id="back" press={press} />);
      } else if (k === "clear") {
        keys.push(
          <Button key={`clear${suffix}`} label={t(app, "clear")} classes="key util" action="key" id="clear" press={press} />,
        );
      } else {
        // Everything else in `rows` is a digit.
        keys.push(<Button key={suffix + k} label={k} classes="key" action="key" id={k} press={press} />);
      }
    }
  }
  keys.push(<Button key={`${suffix}0`} label="0" classes="key" action="key" id="0" press={press} />);
  return <div className="keypad">{keys}</div>;
}

function TakenRow({ app, p }: { app: App; p: model.Payment }): ReactElement {
  return (
    <li className="taken">
      <span>{t(app, model.tender_key(p.tender))}</span>
      <span className="now">{amount(app, p.amount)}</span>
    </li>
  );
}

/**
 * What the tab can still take, in a sentence.
 *
 * Three different refusals read as three different sentences, because "that
 * cannot go on the tab" tells a cashier nothing they can act on: attach a
 * customer, ask a manager to raise the limit, or take part of it in cash are
 * three different next moves.
 */
function tab_note(app: App): string {
  if (app.basket.customer_name.length === 0) {
    return t(app, "tab_needs_customer");
  }
  const room = store.tab_room(app);
  if (room <= 0) {
    return t(app, "tab_no_room");
  }
  return `${t(app, "tab_room")} ${amount(app, room)}`;
}

function WorkTender({ app, press }: Props): ReactElement {
  const due = store.balance_due(app);
  const typed = money.from_keys(app.entry, store.currency_of(app)) ?? 0;

  // The notes a customer actually hands over: the exact amount, then the next
  // round figures up.
  const offers: number[] = [];
  if (due > 0) {
    offers.push(due);
    for (const step of [1000, 5000, 10000, 50000]) {
      const rounded = div(due + step - 1, step) * step;
      if (rounded > due && !offers.includes(rounded) && offers.length < 5) {
        offers.push(rounded);
      }
    }
  }

  return (
    <section className="work tender-work">
      <div className="tender-choose">
        <span className="region">{t(app, "tender_type")}</span>
        <div className="tenders">
          <TenderButton app={app} press={press} tender="Cash" name="cash" />
          <TenderButton app={app} press={press} tender="Card" name="card" />
          <TenderButton app={app} press={press} tender="Wallet" name="wallet" />
          <TenderButton app={app} press={press} tender="StoreCredit" name="store_credit" />
          <TenderButton app={app} press={press} tender="OnAccount" name="on_account" />
        </div>
        {/* What the tab will still take, said plainly and only when it is the
            tender in hand. A cashier choosing cash does not need to be told
            about somebody's credit limit, and a cashier choosing the tab needs
            to be told before they type rather than after they press Add. */}
        <p className="rule">{app.tender === "OnAccount" ? tab_note(app) : t(app, "only_cash_change")}</p>
      </div>
      {/* **The amount lives with the keys that type it.** What is being
          tendered, the notes a customer is likely to hand over and the pad
          itself are one question — how much — and the chooser beside them is
          a different one: which tender. */}
      <div className="tender-keys">
        <div className="entry">
          <span className="entry-label">{t(app, "cash_tendered")}</span>
          <span className="entry-value">{money.plain(typed, store.currency_of(app))}</span>
        </div>
        <div className="quicks">
          {offers.map((value) => (
            <Button
              key={`q${value}`}
              label={money.plain(value, store.currency_of(app))}
              classes="quick"
              action="quick"
              id={int_text(value)}
              press={press}
            />
          ))}
        </div>
        <Keypad key="keypadt" app={app} press={press} suffix="t" />
        <Button
          label={`${t(app, "add_tender")} · ${money.plain(typed, store.currency_of(app))}`}
          classes={typed > 0 ? "commit wide" : "commit wide off"}
          action="add-tender"
          press={press}
        />
      </div>
    </section>
  );
}

/**
 * What has been taken, what is still due, and the two ways out.
 *
 * Drawn into the **ledger** rather than the work area — see the note in
 * [`Ledger`]. It is about the basket, not about the keypad, and every pixel it
 * does not take from the work column is a pixel the numeric surface keeps.
 */
function TenderSummary({ app, press }: Props): ReactElement {
  const due = store.balance_due(app);
  const change = store.change_due(app);
  return (
    <div className="tender-summary">
      {app.taken.length > 0 && (
        <ul className="takens">
          {app.taken.map((p, i) => (
            <TakenRow key={`t${i}`} app={app} p={p} />
          ))}
        </ul>
      )}
      <div className="due">
        <span>{change > 0 ? t(app, "change_due") : t(app, "balance_due")}</span>
        <span className="due-value">{amount(app, change > 0 ? change : due)}</span>
      </div>
      <div className="tender-actions">
        <Button label={t(app, "back_to_sale")} classes="ghost" action="back-to-sale" press={press} />
        <Button
          label={t(app, "finish")}
          classes={due <= 0 && app.taken.length > 0 ? "commit" : "commit off"}
          action="finish"
          press={press}
        />
      </div>
    </div>
  );
}

// ---- commands --------------------------------------------------------------

/**
 * The command bar, built from what the server said this operator may do.
 *
 * A command they lack rights to is drawn **locked rather than hidden** — it is
 * how a cashier learns to call a manager. Destructive commands sit in their
 * own group at the end, never beside a high-frequency target.
 */
function CommandBar({ app, press }: Props): ReactElement {
  const ordinary: ReactNode[] = [];
  const destructive: ReactNode[] = [];
  for (const c of app.basket.commands) {
    let label = model.label_of(c, app.lang);
    if (c.id === "held" && app.basket.held_count > 0) {
      label = `${label} (${app.basket.held_count})`;
    }
    let classes = c.danger ? "command danger" : "command";
    if (!c.allowed) {
      classes = classes + " locked";
    }
    // Drawn inline rather than through `Button`, for the one thing `Button`
    // cannot carry: the padlock after the label. It used to be a `🔒` in the
    // label itself — an emoji, in colour — and is a drawn glyph now, which
    // the stylesheet places in the button's corner. The glyph keeps the
    // emoji as its accessible name, so a screen reader still hears exactly
    // what the label used to say: that this command is locked.
    const node = (
      <button key={c.id} className={classes} type="button" data-action="command" data-id={c.id} onClick={press}>
        {label}
        {!c.allowed && <span className="lock" role="img" aria-label="🔒" />}
      </button>
    );
    if (c.danger) {
      destructive.push(node);
    } else {
      ordinary.push(node);
    }
  }
  return (
    <nav className="commands">
      <div className="command-group">{ordinary}</div>
      <span className="gap" />
      <div className="command-group restricted">{destructive}</div>
    </nav>
  );
}

// ---- overlays --------------------------------------------------------------

/** The parked baskets, or a sentence saying there are none. */
function HeldBody({ app, press }: Props): ReactElement {
  if (app.held.length === 0) {
    return (
      <p key="none" className="lede empty-note">
        {t(app, "no_held")}
      </p>
    );
  }
  return (
    <ul key="list" className="held-list">
      {app.held.map((h) => (
        <li key={h.id} className="held-row">
          <span className="name">{h.label}</span>
          <span className="detail">{`${h.items} ${t(app, "items")} · ${browser.clock_of(h.created_at)}`}</span>
          <span className="now">{amount(app, h.total)}</span>
          <Button label={t(app, "resume")} classes="chip" action="recall" id={h.id} press={press} />
        </li>
      ))}
    </ul>
  );
}

function FoundBody({ app, press }: Props): ReactElement {
  return (
    <ul className="found">
      {app.found.map((p) => (
        <li key={p.id} className="held-row" data-action="tile" data-id={p.id} onClick={press}>
          <span className="name">{store.product_label(p, app.lang)}</span>
          <span className="detail">{p.sku}</span>
          <span className="now">{amount(app, p.price)}</span>
        </li>
      ))}
    </ul>
  );
}

function CustomersBody({ app, press }: Props): ReactElement {
  if (app.customers.length === 0) {
    return (
      <p key="none" className="lede empty-note">
        {t(app, "no_customers")}
      </p>
    );
  }
  return (
    <ul key="list" className="held-list">
      {app.customers.map((cu) => (
        <li key={cu.id} className="held-row" data-action="customer-pick" data-id={cu.id} onClick={press}>
          <span className="name">{cu.name}</span>
          <span className="detail">{cu.phone}</span>
          {/* What they owe sits where the points do, because at a counter it
              is the more urgent of the two: a customer with a tab is somebody
              the shopkeeper wants to mention it to before ringing anything
              else. */}
          {cu.owed > 0 ? (
            <span key="owed" className="now warn">{`${t(app, "owes")} ${amount(app, cu.owed)}`}</span>
          ) : (
            <span key="points" className="now">{`${cu.points} pts`}</span>
          )}
          {/* Its own action, inside the row, so the tap that attaches somebody
              to a basket and the tap that takes money off their tab are two
              different targets rather than one button that guesses. */}
          {cu.owed > 0 && (
            <Button key="settle" label={t(app, "pay_tab")} classes="ghost small" action="pay-tab" id={cu.id} press={press} />
          )}
        </li>
      ))}
    </ul>
  );
}

function ReceiptsBody({ app, press }: Props): ReactElement {
  if (app.receipts.length === 0) {
    return (
      <p key="none" className="lede empty-note">
        {t(app, "no_receipts")}
      </p>
    );
  }
  return (
    <ul key="list" className="held-list">
      {app.receipts.map((r) => (
        <li key={r.id} className="held-row" data-action="receipt-pick" data-id={r.id} onClick={press}>
          <span className="name">{`#${r.number}`}</span>
          <span className="detail">
            {`${r.items} ${t(app, "items")} · ${browser.clock_of(r.completed_at)} · ${r.cashier}`}
          </span>
          <span className="now">{amount(app, r.total)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The lines of a receipt, with a stepper on each.
 *
 * A return is counted out one unit at a time rather than typed, because the
 * customer is standing there with the goods and the operator is looking at
 * them, not at a keypad.
 *
 * The reason box and the total sit inside the list itself, after the rows —
 * the stylesheet lays the panel out from `.held-list`'s children, so that is
 * where they have always been.
 */
function ReturningBody({ app, press }: Props): ReactElement {
  const rows: ReactNode[] = [];
  let total = 0;
  for (const l of app.returning) {
    if (l.returnable <= 0.0) {
      continue;
    }
    const share = l.qty > 0.0 ? l.taking / l.qty : 0.0;
    // Rounded, not truncated: this is the figure the operator reads out to
    // the customer, and it has to match what the server will actually pay.
    total = total + round_to(l.total * share);
    rows.push(
      <li key={l.id} className="return-row">
        <span className="line-body">
          <span className="name">{l.name}</span>
          <span className="detail">
            {`${t(app, "returnable")} ${money.quantity(l.returnable)} · ${amount(app, l.total)}`}
          </span>
        </span>
        <Button label="−" classes="step" action="return-less" id={l.id} press={press} />
        <span className="qty">{money.quantity(l.taking)}</span>
        <Button label="+" classes="step" action="return-more" id={l.id} press={press} />
      </li>,
    );
  }
  if (rows.length === 0) {
    return (
      <p key="none" className="lede empty-note">
        {t(app, "nothing_returnable")}
      </p>
    );
  }
  rows.push(<input key="reason" id="reason" className="scan-field" type="text" placeholder={t(app, "reason")} />);
  rows.push(
    <div key="total" className="due">
      <span>{t(app, "total")}</span>
      <span className="due-value">{amount(app, total)}</span>
    </div>,
  );
  return (
    <ul key="list" className="held-list">
      {rows}
    </ul>
  );
}

/**
 * A receipt, laid out the way it will come out of the printer.
 *
 * Narrow, monospaced and left-aligned, because a thermal roll is 58 or 80 mm
 * of fixed-pitch characters and a receipt that looks like a web page on screen
 * prints as one. Everything here is what the sale was rung at rather than what
 * the catalogue says now — a reprint a week later has to agree with the copy
 * the customer is holding.
 */
function SlipBody({ app, slip }: { app: App; slip: model.Slip | null }): ReactElement {
  if (slip === null) {
    return (
      <p key="none" className="lede empty-note">
        {t(app, "no_receipts")}
      </p>
    );
  }
  const c = store.currency_of(app);
  const out: ReactNode[] = [];

  const title = slip.shop.name.length > 0 ? slip.shop.name : t(app, "point_of_sale");
  out.push(
    <div key="shop" className="s-shop">
      {title}
    </div>,
  );
  [slip.shop.address, slip.shop.phone, slip.shop.tax_id].forEach((line, i) => {
    if (line.length > 0) {
      out.push(
        <div key={`h${i}`} className="s-meta">
          {line}
        </div>,
      );
    }
  });
  out.push(<div key="rule1" className="s-rule" />);

  out.push(
    <div key="no" className="s-row">
      <span>{t(app, "receipt_number")}</span>
      <span>{`#${slip.number}`}</span>
    </div>,
  );
  out.push(
    <div key="when" className="s-row">
      <span>{browser.day_of(slip.completed_at)}</span>
      <span>{browser.clock_of(slip.completed_at)}</span>
    </div>,
  );
  out.push(
    <div key="who" className="s-row">
      <span>{slip.cashier}</span>
      <span>{slip.register_name}</span>
    </div>,
  );
  if (slip.customer.length > 0) {
    out.push(
      <div key="cust" className="s-row">
        <span>{t(app, "customer")}</span>
        <span>{slip.customer}</span>
      </div>,
    );
  }
  out.push(<div key="rule2" className="s-rule" />);

  slip.lines.forEach((line, i) => {
    out.push(
      <div key={`n${i}`} className="s-name">
        {line.name}
      </div>,
    );
    out.push(
      <div key={`l${i}`} className="s-row">
        <span className="s-dim">{`${money.quantity(line.qty)} × ${money.plain(line.unit_price, c)}`}</span>
        <span>{money.plain(line.total, c)}</span>
      </div>,
    );
    if (line.promo_saved > 0) {
      out.push(
        <div key={`p${i}`} className="s-row s-dim">
          <span>{line.promo_name}</span>
          <span>{`-${money.plain(line.promo_saved, c)}`}</span>
        </div>,
      );
    }
  });
  out.push(<div key="rule3" className="s-rule" />);

  if (slip.promo_saved + slip.discount > 0) {
    out.push(
      <div key="saved" className="s-row">
        <span>{t(app, "saved")}</span>
        <span>{money.plain(slip.promo_saved + slip.discount, c)}</span>
      </div>,
    );
  }
  out.push(
    <div key="total" className="s-row s-total">
      <span>{t(app, "total")}</span>
      <span>{money.plain(slip.total, c)}</span>
    </div>,
  );
  if (slip.tax > 0) {
    out.push(
      <div key="tax" className="s-row s-dim">
        <span>{slip.shop.tax_inclusive ? t(app, "tax_included") : t(app, "tax_added")}</span>
        <span>{money.plain(slip.tax, c)}</span>
      </div>,
    );
  }

  slip.payments.forEach((p, i) => {
    out.push(
      <div key={`t${i}`} className="s-row">
        <span>{t(app, p.method)}</span>
        <span>{money.plain(p.amount, c)}</span>
      </div>,
    );
    if (p.change > 0) {
      out.push(
        <div key={`c${i}`} className="s-row">
          <span>{t(app, "change_due")}</span>
          <span>{money.plain(p.change, c)}</span>
        </div>,
      );
    }
  });

  if (slip.shop.footer.length > 0) {
    out.push(<div key="rule4" className="s-rule" />);
    out.push(
      <div key="foot" className="s-foot">
        {slip.shop.footer}
      </div>,
    );
  }
  return (
    <div key="slip" className="slip">
      {out}
    </div>
  );
}

/** A dialog: the dimmed page, a panel, its title and whatever it holds. */
function Shade({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="shade">
      <div className="panel">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** The two-button foot every dialog ends with. */
function Actions({ children }: { children: ReactNode }): ReactElement {
  return <div className="panel-actions">{children}</div>;
}

function Cancel({ app, press }: Props): ReactElement {
  return <Button label={t(app, "cancel")} classes="ghost" action="dismiss" press={press} />;
}

function repeat_dots(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out = out + "•";
  }
  return out;
}

/** The overlay in front of everything, if there is one — keyed by which it is. */
function overlay_of(app: App, press: Press): ReactElement[] {
  const o = app.overlay;
  switch (o.tag) {
    case "None":
      return [];
    case "AgeCheck":
      return [
        <Shade key="age" title={t(app, "age_check")}>
          <p className="lede">{o.name}</p>
          <div className="age-figures">
            <div>
              <span className="k">{t(app, "age_min")}</span>
              <span className="big">{`${o.min_age}`}</span>
            </div>
            {/* The date to check against, so nobody is doing arithmetic at the
                counter with a queue waiting. */}
            <div>
              <span className="k">{t(app, "born_before")}</span>
              <span className="big">{browser.date_of(o.born_before)}</span>
            </div>
          </div>
          <Actions>
            <Button label={t(app, "refuse")} classes="ghost" action="dismiss" press={press} />
            <Button label={t(app, "approve")} classes="commit" action="age-ok" id={o.code} pid={o.product_id} press={press} />
          </Actions>
        </Shade>,
      ];
    case "AskPrice":
      return [
        <Shade key="price" title={t(app, "price")}>
          <p className="lede">{o.name}</p>
          <div className="entry-value">
            {money.plain(money.from_keys(app.entry, store.currency_of(app)) ?? 0, store.currency_of(app))}
          </div>
          <Keypad key="keypadp" app={app} press={press} suffix="p" />
          <Actions>
            <Cancel app={app} press={press} />
            <Button label={t(app, "confirm")} classes="commit" action="price-ok" id={o.product_id} press={press} />
          </Actions>
        </Shade>,
      ];
    case "Held":
      return [
        <Shade key="held" title={t(app, "held")}>
          <HeldBody app={app} press={press} />
          <Actions>
            <Cancel app={app} press={press} />
          </Actions>
        </Shade>,
      ];
    case "Search":
      return [
        <Shade key="search" title={t(app, "search")}>
          <input id="find" className="scan-field" type="text" autoComplete="off" placeholder={t(app, "search")} />
          <FoundBody app={app} press={press} />
          <Actions>
            <Cancel app={app} press={press} />
          </Actions>
        </Shade>,
      ];
    case "Keypad":
      return [
        <Shade key="pad" title={o.title}>
          <div className="entry-value">{app.entry}</div>
          <Keypad key="keypadk" app={app} press={press} suffix="k" />
          <Actions>
            <Cancel app={app} press={press} />
            <Button
              label={t(app, "confirm")}
              classes="commit"
              action="keypad-ok"
              id={o.line_id}
              purpose={o.purpose}
              press={press}
            />
          </Actions>
        </Shade>,
      ];
    case "ManagerPin":
      return [
        <Shade key="mgr" title={t(app, "manager_pin")}>
          <p className="lede">{t(app, "needs_manager")}</p>
          <div className="entry-value pin">{repeat_dots(app.entry.length)}</div>
          <Keypad key="keypadm" app={app} press={press} suffix="m" />
          <Actions>
            <Cancel app={app} press={press} />
            <Button
              label={t(app, "confirm")}
              classes="commit"
              action="manager-ok"
              id={o.line_id}
              purpose={o.purpose}
              amount={int_text(o.amount)}
              press={press}
            />
          </Actions>
        </Shade>,
      ];
    case "Confirm":
      return [
        <Shade key="confirm" title={t(app, "confirm")}>
          <p className="lede">{o.message}</p>
          <input id="reason" className="scan-field" type="text" placeholder={t(app, "reason")} />
          <Actions>
            <Cancel app={app} press={press} />
            <Button label={t(app, "confirm")} classes="commit danger" action="confirm-ok" purpose={o.purpose} press={press} />
          </Actions>
        </Shade>,
      ];
    case "Customers":
      return [
        <Shade key="customers" title={t(app, "customer")}>
          <input id="who" className="scan-field" type="text" autoComplete="off" placeholder={t(app, "customer")} />
          <CustomersBody app={app} press={press} />
          <Actions>
            <Cancel app={app} press={press} />
            <Button label={t(app, "new_customer")} classes="commit" action="customer-new" press={press} />
          </Actions>
        </Shade>,
      ];
    case "Receipts":
      return [
        <Shade key="receipts" title={o.purpose === "print" ? t(app, "receipt") : t(app, "return")}>
          <input
            id="receipt"
            className="scan-field"
            type="text"
            inputMode="numeric"
            placeholder={t(app, "receipt_number")}
          />
          <ReceiptsBody app={app} press={press} />
          <Actions>
            <Cancel app={app} press={press} />
          </Actions>
        </Shade>,
      ];
    case "Returning":
      return [
        <Shade key="returning" title={`${t(app, "return")} · #${o.number}`}>
          <ReturningBody app={app} press={press} />
          <Actions>
            <Cancel app={app} press={press} />
            <Button label={t(app, "confirm")} classes="commit danger" action="return-go" id={o.sale_id} press={press} />
          </Actions>
        </Shade>,
      ];
    case "PriceCheck":
      return [
        <Shade key="check" title={t(app, "price_check")}>
          <p className="lede">{o.name}</p>
          <p className="detail">{o.detail}</p>
          <div className="entry-value">{o.price}</div>
          <Actions>
            <Cancel app={app} press={press} />
          </Actions>
        </Shade>,
      ];
    case "Slip":
      return [
        <Shade key="slip" title={t(app, "receipt")}>
          <SlipBody app={app} slip={app.slip} />
          <Actions>
            <Cancel app={app} press={press} />
            <Button label={t(app, "print")} classes="commit" action="slip-print" press={press} />
          </Actions>
        </Shade>,
      ];
    // Settling a tab. The keypad opens with nothing in it rather than with the
    // balance filled in, because part payment is the ordinary case at a
    // counter — somebody pays what they have on them — and a prefilled field
    // that has to be cleared first is a field that gets sent as it stands.
    // The whole balance is one tap on the quick button instead.
    case "PayTab":
      return [
        <Shade key="paytab" title={`${t(app, "pay_tab")} · ${o.name}`}>
          <div className="due">
            <span>{t(app, "owes")}</span>
            <span className="due-value">{amount(app, o.owed)}</span>
          </div>
          <div className="entry-value">
            {money.plain(money.from_keys(app.entry, store.currency_of(app)) ?? 0, store.currency_of(app))}
          </div>
          <div className="quicks">
            <Button label={t(app, "the_lot")} classes="quick" action="quick" id={int_text(o.owed)} press={press} />
          </div>
          <Keypad key="keypadb" app={app} press={press} suffix="b" />
          <Actions>
            <Cancel app={app} press={press} />
            <Button label={t(app, "confirm")} classes="commit" action="tab-ok" id={o.customer_id} press={press} />
          </Actions>
        </Shade>,
      ];
  }
}

// ---- signing in ------------------------------------------------------------

/**
 * The PIN pad.
 *
 * No username: the pad is built for a touchscreen and a queue, and asking who
 * you are before asking for four digits doubles the taps at the busiest moment
 * of the day. The dots show progress without ever displaying the PIN.
 */
function SignIn({ app, press }: Props): ReactElement {
  const keys: ReactNode[] = [];
  for (const row of [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
  ]) {
    for (const k of row) {
      keys.push(<Button key={`p${k}`} label={k} classes="key" action="pin-key" id={k} press={press} />);
    }
  }
  keys.push(<Button key="pclear" label="⌫" classes="key util" action="pin-key" id="back" press={press} />);
  keys.push(<Button key="p0" label="0" classes="key" action="pin-key" id="0" press={press} />);
  keys.push(<Button key="pgo" label="→" classes="key go" action="pin-go" press={press} />);

  return (
    <main className="signin">
      <h1>{t(app, "enter_pin")}</h1>
      <div className="pin-dots">{repeat_dots(app.pin.length)}</div>
      <div className="keypad pin-pad">{keys}</div>
      <p className="trouble">{app.trouble}</p>
      <div className="lang">
        <Button label="EN" classes={app.lang === "En" ? "lang-on" : "lang-off"} action="lang-en" press={press} />
        <Button
          label="မြန်မာ"
          classes={app.lang === "My" ? "lang-on" : "lang-off"}
          action="lang-my"
          lang="my"
          press={press}
        />
      </div>
    </main>
  );
}

/**
 * What a reload shows while the Worker is asked whose kept token this is.
 *
 * The shop's mark and the application's name, which is what the device itself
 * puts up while an installed till is starting — so a reload and a cold launch
 * look like the same thing rather than one of them flashing a PIN pad.
 *
 * It introduces no new wording: `point_of_sale` is the phrase `words.ts`
 * already carries for the back office, copied into the till's own dictionary
 * because a lane cannot afford to import that file.
 */
function Splash({ app }: { app: App }): ReactElement {
  return (
    <main className="splash">
      <span className="splash-mark">CM</span>
      <h1 className="splash-name">{t(app, "point_of_sale")}</h1>
    </main>
  );
}

// ---- the page --------------------------------------------------------------

/** The whole till. */
export function Page({ app, press }: Props): ReactElement {
  // Before the signed-out test, not after it: a reload holds a token and has
  // no session yet, and only this flag tells that apart from being signed
  // out. The other order is what put a PIN pad in front of a cashier who was
  // already signed in.
  if (app.restoring) {
    return <Splash key="splash" app={app} />;
  }
  if (app.session === null) {
    return <SignIn key="signin" app={app} press={press} />;
  }

  const out: ReactElement[] = [<StatusBar key="status" app={app} press={press} />];
  out.push(
    <main key="main" className={app.mode === "Sale" ? "lane" : "lane tendering"}>
      <Ledger app={app} press={press} />
      {app.mode === "Sale" ? (
        <WorkSale key="work-sale" app={app} press={press} />
      ) : (
        <WorkTender key="work-tender" app={app} press={press} />
      )}
    </main>,
  );
  if (app.mode === "Sale") {
    out.push(<CommandBar key="commands" app={app} press={press} />);
  }
  if (app.trouble.length > 0) {
    out.push(
      <div key="trouble" className="trouble-bar">
        {app.trouble}
      </div>,
    );
  } else if (app.notice.length > 0) {
    out.push(
      <div key="notice" className="notice-bar">
        {app.notice}
      </div>,
    );
  }
  // Always drawn, so the dialog it holds can outlive the store's own: see
  // `Overlay`. `overlay_of` gives at most one.
  out.push(<Overlay key="overlay" node={overlay_of(app, press)[0] ?? null} />);
  return <>{out}</>;
}

/**
 * How long a closing dialog stays on the screen. It is the stylesheet's
 * `--t-close`, which is what the leaving animation runs for; the two are kept
 * equal by hand.
 */
const CLOSE_MS = 180;

/**
 * **Where a dialog comes and goes.**
 *
 * A dialog used to be in the tree while the store said so and gone in the same
 * frame that it stopped saying so — which is a cut, and nothing a stylesheet
 * can animate, because there is no element left to animate. This holds on to
 * the last dialog it was given for `CLOSE_MS` after the store lets it go, and
 * marks it `leaving` so the stylesheet can play it out. It is the same element
 * throughout — React keeps it, typed reasons and scrolled lists and all — and
 * it is `inert` while it leaves, so the tap that closed it cannot land on it
 * twice and nothing in it can take the focus.
 *
 * A dialog that replaces another while it is open — the receipt list giving
 * way to the receipt, a reason to the manager's PIN — is a `swap`: the
 * dimming stays where it is and only the sheet changes, rather than the till
 * flashing up between the two. And a new dialog arriving while the last one
 * is still leaving takes its place at once, so there are never two.
 *
 * The state here is about the screen, never the sale: what the store says is
 * open is what `pos.tsx` acts on, from the moment it says so.
 */
function Overlay({ node }: { node: ReactElement | null }): ReactElement | null {
  const kept = useRef<ReactElement | null>(null);
  const swap = useRef(false);
  const [, redraw] = useState(0);

  if (node !== null) {
    if (kept.current === null) {
      swap.current = false;
    } else if (kept.current.key !== node.key) {
      swap.current = true;
    }
    kept.current = node;
  }
  const leaving = node === null && kept.current !== null;

  useEffect(() => {
    if (!leaving) {
      return;
    }
    const timer = setTimeout(() => {
      kept.current = null;
      redraw((n) => n + 1);
    }, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const shown = node ?? kept.current;
  if (shown === null) {
    return null;
  }
  let classes = "overlay";
  if (swap.current) {
    classes = classes + " swap";
  }
  if (leaving) {
    classes = classes + " leaving";
  }
  return (
    <div className={classes} inert={leaving}>
      {shown}
    </div>
  );
}
