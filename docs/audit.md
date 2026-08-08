# What the audit found

Six independent reviewers read this codebase along one risk dimension each —
money arithmetic, the ledger, concurrency, authorisation, SQL, and the Kite
front ends. They produced 54 candidate findings. The eight most severe were then
handed to separate reviewers whose instructions were to **refute** them, with
instructions to default to refuted unless they could reproduce the defect by
tracing concrete values through the actual code.

**Eight of eight survived.** Three more, clear enough on reading, were taken
from the unverified set. All eleven are fixed, and every one has a regression
check in `api/test/smoke.mjs` that fails against the old code.

None of these were caught by the 48 end-to-end checks that already existed. That
is the useful thing to notice: the tests exercised the happy path and the
refusals the author had thought of, and every bug below lives somewhere else —
in a replay, in a fractional input, in a window predicate, in a guard that read
like a gate.

---

## The structural one, four times over

**Ledger postings were batched with the conditional write they depended on.**

D1 has no interactive transaction, so the pattern throughout is a conditional
write — an `UPDATE … WHERE status = 'held'`, an `INSERT … SELECT … WHERE the
invoice still owes it`. The mistake was putting the *consequences* in the same
`batch()` as the claim, and checking `meta.changes` afterwards.

A statement that matches no rows is a **success**. It does not abort the batch.
So when the claim lost, everything else committed anyway and the 409 was raised
over the top of it:

| Where | What committed after the refusal |
|---|---|
| `POST /purchasing/invoices/:id/pay` | a journal entry paying a supplier who had already been paid |
| `POST /shifts/:id/close` | a second variance and a second sweep — the drawer account went negative by a whole shift's takings |
| `POST /sales/:id/refund` | a second `refunds` row and a second journal entry; `expectedInDrawer` then subtracted the refund twice |
| `POST /till/pay` | payments, stock, loyalty and the journal — all of it a second time, because the result of the `WHERE status = 'held'` claim was **discarded entirely** |

Each duplicated entry balances on its own, so the trial balance still summed to
zero and nothing flagged any of it.

**The fix, everywhere:** make the claim its own round trip, check it landed, and
only then write what depends on it. `api/src/lib/refunds.ts` shows the shape at
its fullest — claim the units, read back what actually landed, and derive the
header, the stock movements and the posting from *that* rather than from what
was hoped for.

---

## Money

**A typed price was never checked for being whole.** `POST /till/scan` read
`body.price` with a bare `typeof === "number"`, while every other price entry
point used `int()`. `1500.5` went in; `extend()` deliberately does not round
when the quantity is a whole number; and the fraction propagated into
`sale_items`, `sales`, `payments` and `journal_lines`. No table is `STRICT`, so
SQLite keeps a REAL in an INTEGER column — and the journal is immutable, so it
could not be corrected.

**Refund amounts were re-rounded on every call.** The amount was
`round(line.total × qty / line.qty)`, computed afresh each time, and the guard
against double-refunding counted only *quantity*. A 6-unit line charged 1,000
refunded one unit at a time paid `round(166.67) = 167` six times — **1,002 paid
back on a line that took 1,000**. A 3-unit line charged 1,000 went the other way
and short-changed the customer by 1. Now the units that *close a line out* are
paid the remainder, so the parts sum to exactly what was charged.

**One request could name the same line twice.** Both entries read
`refunded = 0` — nothing had been written when either was checked — and both
passed the guard. Duplicates are merged before anything is read.

**Store credit was never drawn down.** It was a valid tender, the payment row
and the posting were both written, and nothing decremented `customers.credit`.
The same 5,000 bought 5,000 of goods over and over; a customer with no credit
could spend it; a basket with *no customer at all* could be settled entirely in
store credit. It is now checked before the sale and decremented conditionally
with it.

**Cash paid to a supplier credited the drawer, not the safe.** `expenseEntry`
already special-cases cash to the safe, with a comment explaining exactly why —
a drawer is reconciled against a physical count that knows nothing about a
back-office payment. `supplierPaymentEntry` passed `"cash"` straight through and
left the drawer permanently short by the bill, with no shift to explain it. The
fix was applied to one function and not its neighbour.

---

## Reports

**Every accounting window returned lifetime figures.** `balances()` put
`e.value_at BETWEEN ?1 AND ?2` in the `ON` clause of a `LEFT JOIN`, which does
not remove anything: the `journal_lines` row survives with a NULL entry beside
it and `SUM(l.amount)` counts it regardless. Profit and loss for "the last 30
days" was profit and loss for all time; the balance sheet's `as_at` was ignored,
so an entry value-dated next year appeared in a sheet dated today. `/journal`
for the same window correctly returned nothing — the two reports directly
contradicted each other. The window now lives inside the `SUM`.

---

## Authorisation

**A manager-only command could be lent by a PIN.** The guard read

```ts
if (actor.role === "sale_staff" && approvedBy === actor.userId) throw forbidden(…)
```

and could never be true: `approvalFor()` either throws for a cashier or returns
the *approving manager's* id, never the caller's own. So a cashier holding any
manager's PIN could void a sale, open the drawer, and close a lane — all three
marked ✗ for sale staff in the command matrix. `requireManagerSession()` now
enforces what the matrix says: a manager signs in at the lane with their own
PIN, and the session they get is what authorises it.

---

## The front end

**Settings could never be saved.** Fields were read by the selector
`#f-<name>`, and every settings key contains a dot — so `#f-shop.name` parses as
"the element with id `f-shop` and class `name`" and matched nothing. The form
opened, showed every field empty, and on save wrote `""` over the shop's name,
address, currency and tax ID. Fields are now matched on a `data-field`
attribute, which has no such syntax to trip over.

---

---

# What the fintech review found

A second pass over the corrected code, this time against a stated discipline
rather than a list of risks: five reviewers, one lens each — money types, ledger
discipline, idempotency, balance integrity, tax and reporting. 42 candidates,
the eight most severe verified by separate reviewers instructed to refute.
**Seven survived; one was refuted and dropped.**

The interesting part is what a *second* pass found: two more instances of the
structural mistake above, in the two places the first pass had not reached, and
four defects that only a discipline would name.

## The structural one, twice more

| Where | What committed after the refusal |
|---|---|
| `POST /inventory/adjust` | the stock movement and a stock-loss posting for a count that was rejected — both immutable, and `corrects_id` is never written by any code, so there is no reversal path |
| `POST /till/close-lane` | a second variance and a second sweep, leaving the drawer negative by the whole shift's takings and the safe overstated by the same amount |

`shifts.ts` and `purchasing.ts` had already been fixed. Their twins had not:
the back office's drawer close was correct while the lane's was not, and the
same function that documents the fix sat three files away from a copy of the
bug.

## Tax

**A split return never tied out against the VAT collected.** The refunded amount
was already persisted, and the refund that closes a line out is paid the
remainder — so the amounts sum to exactly what the line was charged. The tax had
no such column. It was re-derived on every call as a proportion of the quantity,
which leaves the residual nowhere to go:

* A 3-unit line carrying 100 of inclusive VAT, returned a unit at a time,
  reversed 33 + 33 + 33 = **99**. One kyat of output tax still owed on goods that
  had come back, and one kyat of revenue reversed that was never earned.
* A 4-unit line carrying 10 reversed 3 + 3 + 3 + 2 = **11** — tax relief the shop
  reclaimed without ever having charged it.

Every entry balanced, so the trial balance stayed at zero and nothing flagged
either one. And because `refund_items` held no tax figure, no report could
explain the difference. `refund_items.tax` is now a column
(`0003_refund_tax.sql`), the closing refund takes `line.tax - refunded_tax`
exactly as it already takes `line.total - refunded_amount`, and the refund
response carries the tax back so the invariant is observable from outside.

## Cash that leaves the shop

**A back-office refund was charged to the sale's own shift.** For a refund taken
days after the sale that is a drawer session which closed days ago. The cash
came out of *today's* till; `expectedInDrawer` looked for refunds on today's
shift and found none; the count came up short by the refund and the shortfall was
booked to cash over and short against a cashier who had done nothing wrong. The
drawer account never returned to zero, and every later shift inherited the
offset.

The office has no drawer. Its refunds now come out of the **safe** — the same
rule `expenseEntry` already applies to a bill paid in cash, and the same one
`supplierPaymentEntry` was corrected to follow in the first audit. A return at a
lane still comes out of that lane's drawer, on the shift that is open *now*.

**Store credit could be refunded to nobody.** A walk-in sale has no
`customer_id`, so `UPDATE customers … WHERE id = (SELECT customer_id …)` matched
nothing — silently, inside a batch whose results were discarded. The liability
was posted, the shop kept the cash, and the customer left with a receipt saying
they had been refunded. The till already refused store credit as a *tender*
without a customer; the same rule now applies at the other end.

## The key that was never read

**`sales.client_id` was write-only.** The `status = 'held'` claim catches a
simultaneous double-tap, but not the case the key exists for: the sale completes
and the *answer* is lost. By then the sale is no longer held, so `activeBasket`
opened a brand-new empty basket and the call died with "there is nothing to pay
for" — no receipt number, no change figure, nothing to say the sale existed. The
cashier's only recovery is to ring the basket again.

Two sales for one basket of goods, stock down twice, and a drawer a full basket
short at close — booked as a loss against the cashier. Nothing in the data links
the two sales: different ids, different numbers, and the `UNIQUE` index on
`client_id` never had a chance to object, because the only statement that wrote
the column was unreachable on the replay path.

Both ends were wrong. The server now looks the key up before anything else runs;
the till mints it once per **basket** rather than once per attempt, which is what
its own comment had claimed all along.

## The refusal that was thrown away

**`money.from_text` refuses rather than guesses** — its docstring says so, in
those words — and every call site wrote `or_else(…, 0)`.

A manager retyping a shelf price as "1,200.00" out of habit, in a currency with
no decimals, sent `price: 0`. The server took it, and the till gave that product
away on every scan. The same keystroke on a supplier invoice sent `total: 0`,
which posts *nothing at all* — `post` drops zero-valued lines — so the payable to
that supplier simply did not exist. On a drawer count it sent
`counted_total: 0`: the whole session's takings booked as a loss, and the sweep
skipped, so the drawer never returned to zero.

The check now runs once, in `submit`, against the fields the form declared,
rather than at nine call sites that each have to remember. A supplier invoice
for nothing is also refused server-side — paying a bill, recording an expense and
moving cash all already refused a non-positive amount, and this was the gap in
the row.

## What could not be reproduced locally

Two of these are races, and `wrangler dev` serves one request at a time: fired
together, the second call reads the first one's result. Their checks assert the
invariant the fix establishes — *a movement exists only for a count that was
accepted*, *one close, one set of postings* — which holds whether or not the
requests overlap, and which the old code broke the moment they did. The comments
beside them say so. A check that cannot fail is worth having only if it is
honest about what it is measuring.

## What this says about the tests

The regression checks added for these live in the *what the audit found* section
of `api/test/smoke.mjs`. Two of them are worth keeping in mind as shapes rather
than as cases:

* **Do the thing twice.** Four of the eleven only appear on a replay. A test
  suite that never repeats a request cannot see them.
* **Make the test itself idempotent.** Running the suite three times in a row is
  what surfaced the duplicate categories and customers — and a suite that
  depends on a fresh database is a suite that will pass while the shop's data
  says otherwise.
