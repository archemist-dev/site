---
title: "Your Payment Succeeded, Your Order Failed. Now What?"
description: "A retry with backoff fixes a failed call. After a payment, it turned missing orders into duplicate ones. I replayed a year of checkouts with a 1% timeout rate: the retry still left 2,182 paid orders missing, and created 1,869 duplicates on top."
pubDate: "2026-11-16"
pillar: "system-design"
cover: "./cover.png"
coverAlt: "The Saga pattern, in plain words: two checkout flows. Retry: paid £11.99, order #1, reply lost, retry, order #2, a double order. Order first: order PENDING, charge with a key, CONFIRMED, one order and 0 refunds."
labs: "https://github.com/archemist-dev/labs/tree/main/07-saga-compensation"
draft: false
---

A retry with backoff fixes a failed call. After a payment, it turned missing orders into duplicate ones. I replayed a year of checkouts with a 1% timeout rate: the retry still left 2,182 paid orders missing, and created 1,869 duplicates on top.

A checkout is two steps in two systems: take the money, then create the order. No transaction covers both. The payment provider will never join your database transaction, so two-phase commit is off the table. When the order step fails, times out, or never runs because a deploy killed the process, the money is taken and no order exists. The customer calls support, and someone refunds by hand.

## A year of checkouts, six ways

The test: a small delivery app, 1,000 checkouts a day for a year, a £19.47 basket. I injected four faults. Each rate is my assumption, not a measurement:

- The create-order call times out 1% of the time. Half of those timeouts happen after the order was created: only the reply was lost.
- The order service says no 0.5% of the time: the slot is gone, an item sold out.
- The process dies right after the charge 0.1% of the time: a deploy, a crash.
- A refund fails 2% of the time per attempt.

Over a year (paid with no order / duplicate orders / refunds; money charged with no order / food sent twice):
- **Charge, then call once**: 3,997 / 0 / 0; £77,822 / £0
- **Retry on timeout**: 2,182 / **1,869** / 0; £42,484 / **£36,389**
- **Retry + idempotency key**: 2,182 / 0 / 0; £42,484 / £0
- **Saga, state in memory**: 378 / 0 / 1,804; £7,360 / £0
- **Saga, durable state**: **0** / 0 / 1,806; £0 / £0
- **Order first, then charge**: **0** / 0 / **0**; £0 / £0

The counts follow the rates I chose: plug in yours and they move. With no handling, 1 checkout in 91 takes money and leaves no order, 11 a day. What doesn't move is which fix closes which hole.

![Bar chart of six checkout strategies over a simulated year. Paid with no order: call once 3,997; retry 2,182 plus 1,869 double orders; retry with key 2,182; saga in memory 378; durable saga 0; order first 0.](/articles/saga-compensation/1-each-fix.png)

## A timeout is a question, not an answer

A timeout means "I don't know". In this test, half the timed-out calls had already created the order. A plain retry creates it again, and the customer gets two deliveries for one payment: £36,389 of food a year.

The fix is an idempotency key: the client sends the same key, the checkout id, on every attempt. The order service stores it with the order, in the same transaction, and a repeat with that key returns the existing order instead of a new one. Payment providers already work this way (Stripe calls it Idempotency-Key). Your order service should too.

![Two lanes. Without a key: create, order 1 is made, the reply is lost, retry, order 2 is made. With the same key: create with key c42, order 1 is made, the reply is lost, retry, the same order 1 comes back.](/articles/saga-compensation/2-timeout.png)

The key only makes retries safe. It can't turn a "no" into a "yes".

## You can't retry a "no"

When the order service rejects an order, every retry gets the same answer. Retry transient errors. For a real "no", run the step that makes up for the charge: a compensation, here a refund.

A refund isn't an undo. The customer saw the charge and waits days for the money back, and the refund can fail too. Retry it. If it keeps failing, it goes to a person, with an alert.

Some payment methods let you hold the money first and capture it later. Where yours do, capture only once the order exists: then a rejected order means releasing a hold, usually with no fee and nothing to refund. Check each method you accept; many charge at once.

## The hole a refund step can't close

At an on-demand delivery app, the payment provider confirmed payments through its webhook, and then order creation failed on technical edge cases. Operators handled the failed orders by hand, and some were missed: the customer had paid, and no order was ever created. The clean-up was manual refunds, retries, and finance reports checked against orders to find charges with nothing behind them.

The fix was an idempotency key on order creation and a refund step when the order couldn't be created. It cost capacity, time taken from the roadmap for something that "only happens on edge cases", and hard conversations with stakeholders about why a rare failure deserved it.

That fix is row 4. The test shows what row 4 still misses: 378 checkouts a year where the process died between the charge and the order. The saga's memory died with the process, so nothing knew a refund was owed. Those are the ones the finance reports find.

Durable state closes it. Write the saga's progress to a table before each step, and let a job resume every saga that stopped halfway. Row 5: zero. That's in the test, which assumes every refund succeeds in the end. In production, a daily reconciliation catches what's left.

## Write the order before you take the money

There's a simpler order of steps. Write the order first, as PENDING, with the checkout id as its key. Charge only once it exists, using the same key. Then confirm the order.

Now a rejection happens before any money moves. The customer sees an error, and nothing is taken. A crash after the charge leaves a PENDING order, and a sweeper job asks the provider about every order stuck in PENDING and confirms or cancels it. Row 6: no orphaned charges, no duplicates and no refunds at all.

This is still the saga from row 5, with durable state. The order row holds the state, and the sweeper resumes it. Only the step you can't undo, the charge, moved to the end.

It moves the "unknown" rather than removing it. A charge can time out too, so retry it with the same key, or ask the provider, before cancelling the order. And while an order is PENDING, nothing ships it, counts it or emails about it.

![Flow: PENDING order, then charge with the key, then CONFIRMED. A rejected PENDING order takes nothing. A crash after the charge goes to a sweeper, which asks the provider and confirms the order. 0 refunds.](/articles/saga-compensation/3-order-first.png)

## The cheap fixes first

1. **Idempotency key on every call that moves money or creates something.** The checkout id works. Store it with the order, in the same transaction.
2. **Treat a timeout as unknown.** Ask again with the same key before you compensate. (Temporal does it the other way round: it registers the compensation before the step and makes it a safe no-op if the step never ran. Either way, don't guess.)
3. **Write the order first, as PENDING, then charge.** A sweeper job resolves every order stuck in PENDING against the provider.
4. **Compensate a real "no" after the money moved.** Refund, retried; a person and an alert after that. Hold-then-capture where your payment methods support it.
5. **Make the webhook handler idempotent.** Providers deliver webhooks at least once, so the same "payment succeeded" can arrive twice, late, or not at all. Use the payment id as the key, and don't rely on the webhook alone.
6. **Reconcile every day.** Charges against orders, as a scheduled job. I'd keep it even with everything above in place: it catches what the rest missed. In the story it was done by hand, from finance reports.

How you wire it depends on size. My rule: while checkout is two services, let them react to each other's events (choreography). Each service then keeps its own state: the order sits in PENDING, and the event goes out through an outbox (the state change and the outgoing message saved in one local transaction). Once creating an order touches three or more services, one order row can't track every step. Put one place in charge of the steps (orchestration), with its own saga table or a workflow engine such as Temporal as the durable state, at the price of one more system to run.

## How I tested

- Pure Python simulation, no server. 365,000 checkouts; the same faults hit the same checkouts in every strategy.
- Fixed random seeds: anyone who runs it gets the same numbers.

## What the test doesn't cover

- **Assumed fault rates.** Real rates depend on your provider and your system. The order of the fixes holds; the counts don't transfer.
- **A provider that never fails.** Only the order side, the process and refunds fail here. Charge timeouts are the open question for order first.
- **Two steps.** Real checkouts add a kitchen, a courier, a notification. Each step that can't be undone, before the point of no return, needs its own compensation.
- **Customers.** A customer who sees an error and pays again isn't modelled. It would add double charges to the first three rows.
- **Holds.** The test charges at once, so every compensation is a refund.

## Decision

Write the order first, as PENDING, and charge with the same key. Give every call that moves money or creates something an idempotency key, ask again when a call times out, and compensate only a real "no". Let a job resolve whatever is stuck, and reconcile charges against orders every day. Once checkout spans three or more services, consider a durable saga: a saga table or Temporal that holds every step's state.

## Trade-off

You stop taking money for orders that don't exist, and operators handle the rare exception instead of every failed checkout. It costs roadmap time for a failure that looks rare, and a conversation with stakeholders to justify it. Order first adds a PENDING state that every other part of the system has to respect, and a sweeper to run. Every step before the point of no return needs its own compensation, which can fail too; steps after it, like a notification, only go forward.

## Principle

For every step you can't undo, design the step that makes up for it.

What does your checkout do today when the order call times out after the payment?

Code and full results: https://github.com/archemist-dev/labs/tree/main/07-saga-compensation

Credit: Hector Garcia-Molina and Kenneth Salem ("Sagas", 1987), Martin Kleppmann and Chris Riccomini (*Designing Data-Intensive Applications*, 2nd ed., 2026), Chris Richardson (*Microservices Patterns*), Stripe API docs (idempotent requests), Temporal docs. The test, words and numbers are mine.
