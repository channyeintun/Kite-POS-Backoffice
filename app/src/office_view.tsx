//! The back office, drawn.
//!
//! Pure functions from `desk.App` to React elements, the same arrangement the
//! till has — no listeners of its own, no requests, no state. Every control
//! names what it means in a `data-action` and hands one `press` handler to
//! `onClick`; `office.tsx` decides what the name means.
//!
//! The shapes come from the design: a filled surface card with a 12 px radius
//! on a slightly darker page (no borders anywhere), a stat card with a 4 px
//! tone bar across its top, a ranked list with a meter under each name, pill
//! buttons, and a dark rail with a section heading between groups.
//!
//! Colour means what it means at the till: green is open or valid, amber and
//! magenta are attention, red is closed or wrong. A shop should not have to
//! learn two vocabularies.

import type { MouseEvent, ReactElement, ReactNode } from "react";
import * as desk from "./desk.ts";
import type { Lang } from "./i18n.ts";
import * as words from "./words.ts";
import { str_len, str_slice } from "./lang.ts";

/** What every control's `onClick` is: one handler, reading the element. */
export type Press = (e: MouseEvent<HTMLElement>) => void;

interface Props {
  app: desk.App;
  press: Press;
}

/**
 * Keys for a list whose items may repeat one.
 *
 * A key is meant to be unique among its siblings, but nothing stops two rows
 * sharing one — two staff with the same name, two products with an empty SKU.
 * The second of a repeat is keyed as its occurrence, so repeats keep their
 * elements in order from one draw to the next rather than trading them.
 */
function unique_keys(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((k) => {
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n === 0 ? k : `${k}\u0000${n}`;
  });
}

// ---- small pieces ----------------------------------------------------------

function Pill({
  label,
  classes,
  action,
  id,
  press,
}: {
  label: string;
  classes: string;
  action: string;
  id?: string;
  press: Press;
}): ReactElement {
  return (
    <button className={classes} type="button" data-action={action} data-id={id} onClick={press}>
      {label}
    </button>
  );
}

function Avatar({ initials, classes }: { initials: string; classes: string }): ReactElement {
  return <span className={classes}>{initials}</span>;
}

/** The heading strip every card carries. */
function CardHead({ heading, note }: { heading: string; note: string }): ReactElement {
  return (
    <div className="card-head">
      <h3 className="card-title">{heading}</h3>
      {note.length > 0 && <span className="card-note">{note}</span>}
      <span className="gap" />
    </div>
  );
}

// ---- the rail --------------------------------------------------------------

function NavItem({ app, target }: { app: desk.App; target: desk.Screen }): ReactElement {
  const slug = desk.slug_of(target);
  let classes = `rail-item i-${slug.length > 0 ? slug : "overview"}`;
  // A drill-down keeps its section lit, so a reader on one receipt can still
  // see where they are.
  if (desk.same_screen(desk.rail_screen_of(app.screen), target)) {
    classes = classes + " on";
  }
  const badge = desk.badge_of(app, target);
  return (
    <a className={classes} href={desk.href_of(target)}>
      <span className="rail-label">{desk.title_of(target, app.lang)}</span>
      {badge.length > 0 && <span className="badge">{badge}</span>}
    </a>
  );
}

/**
 * The rail, grouped as the design groups it.
 *
 * Built by walking `all_screens()` and starting a new group whenever the
 * heading changes, so adding a screen is one line in `desk.ts` and nothing
 * here.
 */
function Rail({ app, press }: Props): ReactElement {
  const kids: ReactNode[] = [
    <div key="brand" className="brand">
      <Avatar initials="CM" classes="mark" />
      <span className="brand-text">
        <strong className="brand-name">{desk.shop_of(app)}</strong>
        <span className="brand-sub">{words.t(app.lang, "layout.back_office")}</span>
      </span>
    </div>,
  ];

  let group = "";
  let items: ReactNode[] = [];
  for (const target of desk.all_screens()) {
    const wanted = desk.group_of(target);
    if (wanted !== group) {
      if (items.length > 0) {
        kids.push(
          <nav key={`g${group}`} className="rail-group">
            {items}
          </nav>,
        );
        items = [];
      }
      if (wanted.length > 0) {
        kids.push(
          <div key={`h${wanted}`} className="rail-head">
            {words.t(app.lang, wanted)}
          </div>,
        );
      }
      group = wanted;
    }
    items.push(<NavItem key={`${desk.slug_of(target)}-item`} app={app} target={target} />);
  }
  if (items.length > 0) {
    kids.push(
      <nav key={`g${group}`} className="rail-group">
        {items}
      </nav>,
    );
  }

  kids.push(
    <div key="foot" className="rail-foot">
      <button className="rail-me" type="button" data-action="sign-out" onClick={press}>
        <Avatar initials={desk.initials_of(desk.who_of(app))} classes="mark small" />
        <span className="brand-text">
          <strong className="brand-name">{desk.who_of(app)}</strong>
          <span className="brand-sub">{words.t(app.lang, "layout.sign_out")}</span>
        </span>
      </button>
    </div>,
  );

  return <aside className={app.rail_open ? "rail open" : "rail"}>{kids}</aside>;
}

// ---- the header ------------------------------------------------------------

/**
 * Lane health, in the back office's own words.
 *
 * The same fact the till's status bar carries, said for somebody who is not
 * standing at a lane: how many are open, what the drawers should hold, and
 * whether any has stopped talking to the Worker.
 */
function Header({ app, press }: Props): ReactElement {
  return (
    <header className="page-head">
      <button
        className="burger"
        type="button"
        aria-label={words.t(app.lang, "layout.toggle_menu")}
        data-action="rail"
        onClick={press}
      />
      <h1 className="page-title">{desk.title_of(app.screen, app.lang)}</h1>
      <span className="gap" />
      <div className="head-right">
        {/* One phrase for any number of lanes: မြန်မာ does not mark plurals,
            so a singular arm would have nothing to say. */}
        {app.lanes_open > 0 && (
          <span className="lane-pill ok">
            {`${words.fill_n(app.lang, "tills.n_lanes_open", `${app.lanes_open}`)} · ${words.fill(app.lang, "tills.n_expected", app.drawer_expected)}`}
          </span>
        )}
        {app.lanes_offline > 0 && (
          <span className="lane-pill warn">{words.fill_n(app.lang, "tills.n_offline", `${app.lanes_offline}`)}</span>
        )}
        {/* English ⇄ မြန်မာ, last in the group and reachable from every
            screen without opening anything. The same two-button shape as the
            till's, so a shopkeeper who has used one knows where the other is. */}
        <div className="lang">
          <button
            className={app.lang === "En" ? "lang-on" : "lang-off"}
            type="button"
            lang="en"
            data-action="lang"
            data-id="en"
            onClick={press}
          >
            English
          </button>
          <button
            className={app.lang === "My" ? "lang-on" : "lang-off"}
            type="button"
            lang="my"
            data-action="lang"
            data-id="my"
            onClick={press}
          >
            မြန်မာ
          </button>
        </div>
      </div>
    </header>
  );
}

// ---- the blocks ------------------------------------------------------------

function StatCard({ s }: { s: desk.Stat }): ReactElement {
  return (
    <div className="stat">
      {/* A 4 px field of colour across the top, which is the whole of how a
          stat card carries machine state. */}
      <span className={s.tone.length > 0 ? `stat-tone ${s.tone}` : "stat-tone"} />
      <span className="stat-label">{s.label}</span>
      <span className="stat-value">{s.value}</span>
      <span className="stat-meta">{s.meta}</span>
    </div>
  );
}

function MeterRow({ m }: { m: desk.Meter }): ReactElement {
  return (
    <div className="meter">
      <span className="rank">{m.rank}</span>
      <div className="meter-body">
        <strong className="meter-name">{m.name}</strong>
        <div className="track">
          {/* The one inline style in this application: a width that is data
              cannot be a class. */}
          <div className="fill" style={{ width: `${m.width}%` }} />
        </div>
      </div>
      <div className="meter-value">
        <span>{m.value}</span>
        <small>{m.sub}</small>
      </div>
    </div>
  );
}

/**
 * Whether a column holds figures.
 *
 * Decided once per table, not once per cell: a heading that sits left over a
 * column of right-aligned amounts is a heading that belongs to no column. A
 * column counts as numeric when every non-empty cell in it is a figure, so one
 * blank cell does not turn the column back into prose.
 */
function is_amount(cell: string): boolean {
  if (cell.length === 0) {
    return false;
  }
  const head = str_slice(cell, 0, 1);
  if (head === "−" || head === "-") {
    return true;
  }
  if (head >= "0" && head <= "9" && head.length === 1) {
    return true;
  }
  return cell.startsWith("K") && str_len(cell) < 16;
}

function numeric_columns(table: desk.Table): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < table.columns.length; i++) {
    let seen = false;
    let all_figures = true;
    for (const r of table.rows) {
      const cell = r.cells[i] ?? "";
      if (cell.length === 0) {
        continue;
      }
      seen = true;
      if (!is_amount(cell)) {
        all_figures = false;
      }
    }
    out.push(seen && all_figures);
  }
  return out;
}

function column_class(i: number, numeric: boolean[]): string {
  if (i === 0) {
    return "cell first";
  }
  if (numeric[i] ?? false) {
    return "cell num";
  }
  return "cell";
}

function TableRow({ r, numeric, press }: { r: desk.Row; numeric: boolean[]; press: Press }): ReactElement {
  const touchable = r.action.length > 0;
  return (
    <tr
      className={r.tone.length > 0 ? `trow ${r.tone}` : "trow"}
      data-action={touchable ? r.action : undefined}
      data-id={touchable ? r.id : undefined}
      onClick={touchable ? press : undefined}
    >
      {r.cells.map((cell, i) => (
        <td key={`c${i}`} className={column_class(i, numeric)}>
          {cell}
        </td>
      ))}
    </tr>
  );
}

function TableBlock({ table, l, press }: { table: desk.Table; l: Lang; press: Press }): ReactElement {
  const numeric = numeric_columns(table);
  const keys = unique_keys(table.rows.map((r) => r.key));
  return (
    <section className="card">
      <CardHead heading={table.heading} note={table.note} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {table.columns.map((column, i) => (
                <th key={`h${i}`} className={column_class(i, numeric)}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 ? (
              <tr key="none">
                <td className="cell empty" colSpan={Math.max(table.columns.length, 1)}>
                  {words.t(l, "common.nothing_here_yet")}
                </td>
              </tr>
            ) : (
              table.rows.map((r, i) => <TableRow key={keys[i]} r={r} numeric={numeric} press={press} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * One lane, as a card.
 *
 * This is what "a manager reaches a till here" looks like: who is on it, what
 * the drawer should hold, what it is in the middle of, and the two things a
 * manager can actually do from a desk — authorise, or take the lane off them.
 */
function LaneCardView({ t, l, press }: { t: desk.LaneCard; l: Lang; press: Press }): ReactElement {
  return (
    <div className={`lane-card ${t.tone}`}>
      <div className="lane-top">
        <h3 className="card-title">{t.name}</h3>
        <span className="gap" />
        <span className={`state ${t.tone}`}>{t.state}</span>
      </div>
      <div className="lane-who">
        <Avatar initials={t.initials} classes="mark small" />
        <span className="brand-text">
          <strong className="brand-name">{t.operator}</strong>
          <span className="brand-sub">{t.since}</span>
        </span>
      </div>
      <div className="lane-figures">
        <div>
          <span className="k">{words.t(l, "tills.drawer")}</span>
          <strong className="v">{t.drawer}</strong>
        </div>
        <div>
          <span className="k">{words.t(l, "common.sales")}</span>
          <strong className="v">{t.sales}</strong>
        </div>
        <div>
          <span className="k">{words.t(l, "ui.held")}</span>
          <strong className="v">{t.held}</strong>
        </div>
      </div>
      <p className="lane-note">{t.note}</p>
      <div className="lane-actions">
        <Pill label={words.t(l, "tills.authorise")} classes="pill soft" action="authorise" id={t.id} press={press} />
        <Pill label={words.t(l, "tills.shift_detail")} classes="pill quiet" action="shift-detail" id={t.id} press={press} />
        <span className="gap" />
        {t.closeable && <Pill label={t.close_label} classes="pill danger" action="close-lane" id={t.id} press={press} />}
      </div>
    </div>
  );
}

function RoleCardView({ r }: { r: desk.RoleCard }): ReactElement {
  return (
    <div className="role-card">
      <span className="role-name">{r.role}</span>
      <strong className="role-opens">{r.opens}</strong>
      <p className="role-body">{r.body}</p>
      <div className="chips">
        {r.chips.map((chip, i) => (
          <span key={`c${i}`} className="chip">
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatsBlock({ items }: { items: desk.Stat[] }): ReactElement {
  const keys = unique_keys(items.map((s) => s.label));
  return (
    <div className="stats">
      {items.map((s, i) => (
        <StatCard key={keys[i]} s={s} />
      ))}
    </div>
  );
}

function MetersBlock({ heading, note, rows, l }: { heading: string; note: string; rows: desk.Meter[]; l: Lang }): ReactElement {
  const keys = unique_keys(rows.map((m) => m.key));
  return (
    <section className="card">
      <CardHead heading={heading} note={note} />
      <div className="meters">
        {rows.length === 0 && (
          <p key="none" className="empty-note">
            {words.t(l, "common.nothing_here_yet")}
          </p>
        )}
        {rows.map((m, i) => (
          <MeterRow key={keys[i]} m={m} />
        ))}
      </div>
    </section>
  );
}

function LanesBlock({ cards, l, press }: { cards: desk.LaneCard[]; l: Lang; press: Press }): ReactElement {
  const keys = unique_keys(cards.map((c) => c.id));
  return (
    <div className="lane-grid">
      {cards.map((c, i) => (
        <LaneCardView key={keys[i]} t={c} l={l} press={press} />
      ))}
    </div>
  );
}

function RolesBlock({ cards }: { cards: desk.RoleCard[] }): ReactElement {
  const keys = unique_keys(cards.map((c) => c.role));
  return (
    <div className="role-grid">
      {cards.map((c, i) => (
        <RoleCardView key={keys[i]} r={c} />
      ))}
    </div>
  );
}

function action_buttons(items: desk.Action[], press: Press): ReactNode[] {
  const keys = unique_keys(items.map((a, i) => `a${i}${a.action}${a.id}`));
  return items.map((a, i) => (
    <Pill key={keys[i]} label={a.label} classes={`pill ${a.tone}`} action={a.action} id={a.id} press={press} />
  ));
}

function ButtonsBlock({ items, press }: { items: desk.Action[]; press: Press }): ReactElement {
  return <div className="buttons">{action_buttons(items, press)}</div>;
}

/**
 * The header of a drill-down.
 *
 * A title, the handful of facts a reader wants before anything else, and what
 * can be done from here. The facts are a grid rather than prose because they
 * are read at a glance and compared against each other.
 */
function DetailBlock({
  title,
  subtitle,
  facts,
  actions,
  press,
}: {
  title: string;
  subtitle: string;
  facts: desk.Fact[];
  actions: desk.Action[];
  press: Press;
}): ReactElement {
  return (
    <section className="card detail">
      <div className="detail-top">
        <div>
          <h2 className="detail-title">{title}</h2>
          <p className="detail-sub">{subtitle}</p>
        </div>
        <span className="gap" />
        <div className="detail-actions">{action_buttons(actions, press)}</div>
      </div>
      <div className="facts">
        {facts.map((f, i) => (
          <div key={`f${i}`} className="fact">
            <span className="k">{f.label}</span>
            <strong className={f.tone.length > 0 ? `v ${f.tone}` : "v"}>{f.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A receipt, laid out to be printed.
 *
 * Monospaced and narrow, because that is the shape of the paper it comes out
 * on. `@media print` in the stylesheet drops everything else on the page, so
 * the browser's own print dialog is the print button.
 */
function ReceiptBlock({ lines, head, foot }: { lines: string[]; head: string[]; foot: string[] }): ReactElement {
  const out: ReactNode[] = [];
  head.forEach((l, i) => {
    out.push(
      <div key={`h${i}`} className="r-head">
        {l}
      </div>,
    );
  });
  out.push(<div key="rule1" className="r-rule" />);
  lines.forEach((l, i) => {
    out.push(
      <div key={`l${i}`} className="r-line">
        {l}
      </div>,
    );
  });
  out.push(<div key="rule2" className="r-rule" />);
  foot.forEach((l, i) => {
    out.push(
      <div key={`f${i}`} className="r-foot">
        {l}
      </div>,
    );
  });
  return (
    <section className="card receipt-card">
      <div className="receipt">{out}</div>
    </section>
  );
}

function NoteBlock({ heading, body }: { heading: string; body: string }): ReactElement {
  return (
    <section className="card">
      <CardHead heading={heading} note="" />
      <p className="card-body">{body}</p>
    </section>
  );
}

/**
 * One block, drawn.
 *
 * **The key carries the kind as well as the position.** Keyed on the index
 * alone, a `Stats` block at position 3 and a `Grid` block at position 3 would
 * look like the same element, which would then be patched from one into the
 * other instead of replaced — and switching from Summary to Trial balance in
 * the books swaps exactly that pair at the same position.
 */
function block_of(block: desk.Block, index: number, l: Lang, press: Press): ReactElement {
  switch (block.tag) {
    case "Stats":
      return <StatsBlock key={`stats${index}`} items={block.items} />;
    case "Meters":
      return <MetersBlock key={`meters${index}`} heading={block.heading} note={block.note} rows={block.rows} l={l} />;
    case "Grid":
      return <TableBlock key={`grid${index}`} table={block.table} l={l} press={press} />;
    case "Lanes":
      return <LanesBlock key={`lanes${index}`} cards={block.cards} l={l} press={press} />;
    case "Roles":
      return <RolesBlock key={`roles${index}`} cards={block.cards} />;
    case "Note":
      return <NoteBlock key={`note${index}`} heading={block.heading} body={block.body} />;
    case "Buttons":
      return <ButtonsBlock key={`buttons${index}`} items={block.items} press={press} />;
    case "Detail":
      return (
        <DetailBlock
          key={`detail${index}`}
          title={block.title}
          subtitle={block.subtitle}
          facts={block.facts}
          actions={block.actions}
          press={press}
        />
      );
    case "Receipt":
      return <ReceiptBlock key={`receipt${index}`} lines={block.lines} head={block.head} foot={block.foot} />;
  }
}

// ---- the form dialog -------------------------------------------------------

/**
 * An input's `value` attribute — its default — and never its live value.
 *
 * What a form offers is the input's default; what somebody types is its
 * value, and the browser keeps the two apart. React's `defaultValue` writes
 * the live value when the input is built, which marks the field as typed-in,
 * so a default that changes while the dialog is open — Goods In's cost,
 * following the product chooser — would never show. Writing the attribute
 * moves a field nobody has touched and leaves a typed one alone.
 */
function default_value(value: string): (el: HTMLInputElement | null) => void {
  return (el) => {
    if (el !== null && el.getAttribute("value") !== value) {
      el.setAttribute("value", value);
    }
  };
}

/**
 * One field.
 *
 * Every input carries `data-field="<name>"`, which is the whole contract
 * between this file and `office.tsx`: the submit handler reads the fields the
 * form declared, by name, and never has to know which screen opened it.
 *
 * The inputs are the browser's own: what somebody types stays in the element
 * until Save reads it, and a redraw while they type — the lanes are re-read
 * every thirty seconds — leaves it where it is.
 */
function FieldRow({ f, l, press }: { f: desk.Field; l: Lang; press: Press }): ReactElement {
  const id = `f-${f.name}`;
  let control: ReactElement;
  switch (f.kind.tag) {
    case "OneLine":
      control = (
        <input id={id} data-field={f.name} className="field" type="text" ref={default_value(f.value)} autoComplete="off" />
      );
      break;
    case "Lines":
      control = <textarea id={id} data-field={f.name} className="field lines" rows={3} defaultValue={f.value} />;
      break;
    case "Money":
      control = (
        <input
          id={id}
          data-field={f.name}
          className="field"
          type="text"
          inputMode="decimal"
          ref={default_value(f.value)}
          autoComplete="off"
        />
      );
      break;
    case "Whole":
      control = <input id={id} data-field={f.name} className="field" type="number" step="1" ref={default_value(f.value)} />;
      break;
    case "Quantity":
      control = (
        <input id={id} data-field={f.name} className="field" type="number" step="0.001" ref={default_value(f.value)} />
      );
      break;
    case "Choice":
      control = <Choice id={id} name={f.name} options={f.kind.options} labels={f.kind.labels} value={f.value} />;
      break;
    case "Toggle":
      control = (
        <label className="toggle">
          <input id={id} data-field={f.name} type="checkbox" defaultChecked={f.value === "1"} />
          <span>{f.hint}</span>
        </label>
      );
      break;
    case "Password":
      control = <input id={id} data-field={f.name} className="field" type="password" autoComplete="new-password" />;
      break;
    // Two inputs, not one. `accept="image/*"` alone offers a phone the choice
    // of camera or library, but on a desktop it is a file picker only — and a
    // counter tablet is the device this is for. `capture` opens the camera
    // directly; without it, the library. Both are hidden and driven by their
    // labels, because a bare file input cannot be styled.
    case "Photo":
      control = (
        <div className="photo-field">
          {f.value.length > 0 ? (
            <img key="preview-img" className="photo-preview" src={`/api/photos/${f.value}`} alt="" />
          ) : (
            <div key="preview-box" className="photo-preview empty" />
          )}
          <label className="photo-button">
            <span>{words.t(l, "products.take_photo")}</span>
            <input
              className="photo-input"
              type="file"
              accept="image/*"
              capture="environment"
              data-action="photo-pick"
              onClick={press}
            />
          </label>
          <label className="photo-button">
            <span>{words.t(l, "products.choose_photo")}</span>
            <input className="photo-input" type="file" accept="image/*" data-action="photo-pick" onClick={press} />
          </label>
          {f.value.length > 0 ? (
            <button key="remove" className="photo-button quiet" type="button" data-action="photo-remove" onClick={press}>
              {words.t(l, "products.remove_photo")}
            </button>
          ) : (
            <span key="no-remove" />
          )}
        </div>
      );
      break;
    case "Readonly":
      control = <div className="field readonly">{f.value}</div>;
      break;
  }

  return (
    <div className="field-row">
      <label className="field-label" htmlFor={id}>
        {f.required ? `${f.label} *` : f.label}
      </label>
      {control}
      {f.hint.length > 0 && f.kind.tag !== "Toggle" && <span className="field-hint">{f.hint}</span>}
    </div>
  );
}

function Choice({
  id,
  name,
  options,
  labels,
  value,
}: {
  id: string;
  name: string;
  options: string[];
  labels: string[];
  value: string;
}): ReactElement {
  const keys = unique_keys(options);
  return (
    <select id={id} data-field={name} className="field" defaultValue={value}>
      {options.map((o, i) => (
        <option key={keys[i]} value={o}>
          {labels[i] ?? o}
        </option>
      ))}
    </select>
  );
}

function Dialog({ f, l, press }: { f: desk.Form; l: Lang; press: Press }): ReactElement {
  const keys = unique_keys(f.fields.map((field) => field.name));
  return (
    <div className="shade">
      <div className="form-panel">
        <h2 className="form-title">{f.title}</h2>
        {f.lede.length > 0 && <p className="form-lede">{f.lede}</p>}
        {f.trouble.length > 0 && <div className="trouble-bar">{f.trouble}</div>}
        <div className="fields">
          {f.fields.map((field, i) => (
            <FieldRow key={keys[i]} f={field} l={l} press={press} />
          ))}
        </div>
        <div className="form-actions">
          <Pill label={words.t(l, "common.cancel")} classes="pill quiet" action="form-cancel" press={press} />
          <Pill
            label={f.busy ? words.t(l, "common.saving") : f.submit}
            classes="pill filled"
            action="form-submit"
            press={press}
          />
        </div>
      </div>
    </div>
  );
}

// ---- signing in ------------------------------------------------------------

function SignIn({ app, press }: Props): ReactElement {
  return (
    <main className="office-signin">
      <div className="signin-card">
        <Avatar initials="CM" classes="mark" />
        <h1>{words.t(app.lang, "layout.back_office")}</h1>
        {/* Said plainly, because a cashier who lands here by following a
            bookmark should be told where to go rather than left guessing at a
            password. */}
        <p className="lede">{words.t(app.lang, "login.managers_and_owners_sign_in_here")}</p>
        <input
          id="username"
          className="field"
          type="text"
          placeholder={words.t(app.lang, "common.username")}
          autoComplete="username"
        />
        <input
          id="password"
          className="field"
          type="password"
          placeholder={words.t(app.lang, "common.password")}
          autoComplete="current-password"
        />
        <Pill
          label={app.signing_in ? words.t(app.lang, "login.signing_in") : words.t(app.lang, "common.sign_in")}
          classes="pill filled wide"
          action="sign-in"
          press={press}
        />
        <p className="trouble">{app.trouble}</p>
      </div>
    </main>
  );
}

/**
 * What a reload shows while the Worker is asked whose kept token this is.
 * The desk's own mark and name — see the till's for why it invents no words.
 */
function Splash({ app }: { app: desk.App }): ReactElement {
  return (
    <main className="splash">
      <Avatar initials="CM" classes="mark splash-mark" />
      <h1 className="splash-name">{words.t(app.lang, "layout.back_office")}</h1>
    </main>
  );
}

// ---- the page --------------------------------------------------------------

export function Page({ app, press }: Props): ReactElement {
  // Before the signed-out test — see the note on the till's `Page`.
  if (app.restoring) {
    return <Splash key="splash" app={app} />;
  }
  if (app.session === null) {
    return <SignIn key="signin" app={app} press={press} />;
  }

  const body: ReactElement[] = [];
  // The greeting, which is the design's way of saying whose shop this is
  // before it says anything about it.
  if (app.screen.tag === "Overview") {
    body.push(
      <div key="greet" className="greeting">
        <div>
          <h2 className="greet-title">{words.fill(app.lang, "dashboard.greet_day", desk.who_of(app))}</h2>
          <p className="greet-sub">{desk.shop_of(app)}</p>
        </div>
        <span className="gap" />
        <div className="greet-actions">
          <Pill label={words.t(app.lang, "common.reports")} classes="pill soft" action="go" id="reports" press={press} />
          <Pill label={words.t(app.lang, "nav.tills")} classes="pill filled" action="go" id="tills" press={press} />
        </div>
      </div>,
    );
  }
  if (app.trouble.length > 0) {
    body.push(
      <div key="trouble" className="trouble-bar">
        {app.trouble}
      </div>,
    );
  }
  app.blocks.forEach((block, i) => {
    body.push(block_of(block, i, app.lang, press));
  });

  const out: ReactElement[] = [
    <div key="shell" className="office">
      <Rail app={app} press={press} />
      {/* **The page says when it is working.** Not decoration: the buttons
          inside it write, and a shop on a slow line taps a button again when
          nothing happens. The handlers refuse the second press, but a button
          that looks exactly as it did before the first one is a button that
          invites it. The rail is deliberately outside this — moving to
          another screen while one is loading is legitimate. */}
      <main className={app.busy ? "page working" : "page"}>
        <Header app={app} press={press} />
        <div className="scroll">
          <div className="inner">{body}</div>
        </div>
      </main>
    </div>,
  ];
  // **One sign that the page is working: a thin green bar across the top.**
  // Drawn only while busy, so it is gone the moment the answer lands.
  if (app.busy) {
    out.push(
      <div key="progress" className="progress" role="progressbar" aria-label={words.t(app.lang, "common.loading")}>
        <div className="progress-bar" />
      </div>,
    );
  }
  const open = app.form;
  if (open !== null) {
    out.push(<Dialog key="dialog" f={open} l={app.lang} press={press} />);
  }
  return <>{out}</>;
}
