import type { Role } from "../env.js";

/**
 * The command bar, as data.
 *
 * The research is explicit that this is the pattern worth borrowing from the
 * enterprise tills: in Xstore every menu button is retailer-configurable and
 * mapped to a function key, and a button the signed-in associate lacks rights
 * to carries a **lock icon rather than disappearing**. That last part is the
 * whole design — a hidden command teaches a cashier nothing, and a locked one
 * teaches them to call a manager.
 *
 * So each command names the permission that gates it and the till renders all
 * of them, styling the ones this operator cannot reach. The set is a function
 * of mode × role, and both variants come from this one table.
 */

export type Gate =
  | "always"
  /** A cashier may do it with a manager's PIN entered at the lane. */
  | "manager_pin"
  /** Managers and owners only; no PIN can lend it to a cashier. */
  | "manager_only";

export type Confirm = "none" | "explicit" | "reason";

export type Mode = "sale" | "tender";

export type Command = {
  id: string;
  label: string;
  labelMy: string;
  /** F-key, as Xstore maps them. 0 for none. */
  fkey: number;
  gate: Gate;
  confirm: Confirm;
  /** Destructive commands sit in their own pinned group, never beside Pay. */
  tone: "normal" | "danger";
  modes: Mode[];
};

export const COMMANDS: readonly Command[] = [
  {
    id: "hold",
    label: "Hold",
    labelMy: "ဆိုင်းငံ့",
    fkey: 3,
    gate: "always",
    confirm: "none",
    tone: "normal",
    modes: ["sale"],
  },
  {
    id: "held",
    label: "Held",
    labelMy: "ဆိုင်းငံ့စာရင်း",
    fkey: 4,
    gate: "always",
    confirm: "none",
    tone: "normal",
    modes: ["sale"],
  },
  {
    id: "customer",
    label: "Customer",
    labelMy: "ဖောက်သည်",
    fkey: 5,
    gate: "always",
    confirm: "none",
    tone: "normal",
    modes: ["sale"],
  },
  {
    id: "price_check",
    label: "Price check",
    labelMy: "စျေးနှုန်းစစ်",
    fkey: 7,
    gate: "always",
    confirm: "none",
    tone: "normal",
    modes: ["sale"],
  },
  {
    id: "void_line",
    label: "Void line",
    labelMy: "စာကြောင်းဖျက်",
    fkey: 0,
    gate: "always",
    confirm: "explicit",
    tone: "normal",
    modes: ["sale"],
  },
  {
    id: "discount",
    label: "Discount",
    labelMy: "လျှော့စျေး",
    fkey: 6,
    gate: "manager_pin",
    confirm: "none",
    tone: "normal",
    modes: ["sale"],
  },
  {
    id: "price_override",
    label: "Price override",
    labelMy: "စျေးနှုန်းပြင်",
    fkey: 0,
    gate: "manager_pin",
    confirm: "explicit",
    tone: "normal",
    modes: ["sale"],
  },
  {
    id: "return",
    label: "Return",
    labelMy: "ပြန်အမ်း",
    fkey: 0,
    gate: "manager_pin",
    confirm: "reason",
    tone: "danger",
    modes: ["sale"],
  },
  {
    id: "void_sale",
    label: "Void sale",
    labelMy: "ပယ်ဖျက်",
    fkey: 0,
    gate: "manager_only",
    confirm: "reason",
    tone: "danger",
    modes: ["sale"],
  },
  {
    id: "no_sale",
    label: "No sale",
    labelMy: "အရောင်းမရှိ",
    fkey: 0,
    gate: "manager_only",
    confirm: "explicit",
    tone: "danger",
    modes: ["sale"],
  },
  {
    id: "close_lane",
    label: "Close lane",
    labelMy: "လိုင်းပိတ်",
    fkey: 0,
    gate: "manager_only",
    confirm: "explicit",
    tone: "danger",
    modes: ["sale"],
  },
];

export type Resolved = Command & {
  /** Whether this operator can invoke it at all. */
  allowed: boolean;
  /** Whether invoking it will ask for a manager's PIN first. */
  needsApproval: boolean;
};

/**
 * The command bar for one operator, in one mode.
 *
 * Every command comes back, including the ones this operator cannot use —
 * `allowed: false` is what the till draws as locked. Filtering here would make
 * the lock impossible to render, which is the mistake this shape exists to
 * prevent.
 */
export function commandsFor(role: Role, mode: Mode): Resolved[] {
  const manager = role === "manager" || role === "owner";
  return COMMANDS.filter((c) => c.modes.includes(mode)).map((c) => ({
    ...c,
    allowed: manager || c.gate !== "manager_only",
    needsApproval: !manager && c.gate === "manager_pin",
  }));
}
