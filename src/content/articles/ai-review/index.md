---
title: "Your AI Reviewer Only Knows the Rules You Wrote Down"
description: "Same AI reviewer, same bug. With the rule written in a comment, it blocked the bug 3 times out of 3. With the comment deleted, it called the bug \"a business decision\"."
pubDate: "2026-11-09"
pillar: "ai"
cover: "./cover.png"
coverAlt: "Title: Same bug. Same AI reviewer. Two code cards with the same line, discount = 10% of (items + delivery). Top card has the comment \"promo: item subtotal only\": blocked 3 of 3, AI says \"breaks the written terms\". Bottom card, comment deleted: missed 3 of 3, AI says \"a business decision\". Claude Code review, 3 runs each. Archemist logo in the corner."
labs: "https://github.com/archemist-dev/labs/tree/main/05-ai-review"
draft: false
---

Same AI reviewer, same bug. With the rule written in a comment, it blocked the bug 3 times out of 3. With the comment deleted, it called the bug "a business decision".

AI writes more of the code now, and review is the bottleneck. The common answer: put an AI reviewer on every pull request and let it catch what the AI got wrong. I tested what it actually catches.

## The promo that came off delivery

An order: £11.99 of food, £4.99 delivery, and a 10% promo. The promo terms say: item subtotal only.

A pull request changes the discount to cover the whole order, delivery included. It even has a good reason: guests expect 10% off the total they see. The diff is two lines, reads clean and passes every test. From then on, every promo order with a delivery fee gives away an extra 50p, and nothing reports an error.

I gave this PR to Claude Code as the reviewer, 3 times each way:

- **Rule written** in a comment in the code ("a percentage promo applies to the item subtotal only"): blocked 3 of 3.
- **Comment deleted**, same code: missed 3 of 3. "A business decision to confirm." "Good to merge once tests are added."

The reviewer didn't get worse. It lost the one sentence that made the change wrong.

You could say it was right to ask: without the rule, nobody can know. True, and that's the problem. Next to "good to merge", a question reads as a yes.

## The same miss, by a human

At a delivery platform, couriers carried chained orders: several orders on one trip. The chaining code was written with an AI assistant, passed its tests and was approved by a human reviewer.

The code read each courier's orders from a copy of the data that ran a few seconds behind, built for the dispatch screen. When an order moved from one courier to another, the copy still showed the old picture. A new order that arrived in those seconds went to a courier who no longer went there. Every call returned success. It was found later, from customer and ops complaints.

![The copy was seconds behind. Order A just moved from courier_7 to courier_9. Real data: courier_9 has A. Screen copy, seconds behind: courier_7 still has A. New order N, next to A, went to courier_7 (read from the copy); it should go to courier_9 (real data). No error.](/articles/ai-review/2-stale-view.png)

The lag wasn't hidden. The rule that the copy is for screens, not for decisions, was written nowhere.

I rebuilt this bug in the test, with that rule deleted too. The AI reviewer saw the lag every time. Then it concluded "correctness holds, what suffers is chaining quality". The same mistake the human made.

## The pattern

The test has 10 bugs like these. Each one looks correct in the diff and breaks a rule that lives somewhere else. With the rules written in the code, the reviewer caught all 10, in every run. With the rules deleted, it still caught 8.

![Delete the comments: 8 of 10 caught. 10 silent bugs, same AI reviewer, same code. Rule shows in the code (8 bugs, e.g. km vs metres): 8 of 8 caught with the comment kept, 8 of 8 with it deleted. Rule only in a comment (2 bugs, promo and stale copy): 2 of 2 kept, 0 of 2 deleted.](/articles/ai-review/1-written-vs-not.png)

The 8 break a rule the code itself shows: a distance in kilometres compared with a limit in metres, right next to a function that returns metres; an error the caller already catches by name. Code counts as writing too.

The 2 misses, the promo and the courier copy, break rules that live only in someone's head. A reviewer, human or AI, reads a broken unwritten rule as a design choice. And a design choice looks fine.

## The cheap fixes first

1. **Write the rule where the next reader looks.** One sentence next to the code, or in a rules file the reviewer loads (CLAUDE.md, a review guide): "Promos apply to the item subtotal only." "Display only; decisions read the store." With those in place, the same reviewer caught all 10.
2. **Better, make the rule a test.** A test that a promo never touches delivery. Then CI fails even when every reviewer misses it.
3. **Narrow the reviewer.** A prompt that asks only for silent failures, and to read callers, comments and config before the diff, caught the same 10 with 1.6 comments per PR instead of 5.5, no false alarms, for $0.03 a PR. That result gets its own post.
4. **Review the rules, not only the lines.** When a change touches money, shared data or a contract, ask: which rule does this depend on, and is it written down?

## How I tested

- A small order service in Python (prices in pence, a Cambridge address) and 20 small pull requests: 10 with one silent bug each, 10 doing the same features right, to count false alarms. All 20 pass the existing tests. A script runs each bug and its correct twin on the same scenario to prove the bug is real.
- Claude Code (Sonnet 5.5) in headless mode with read-only tools, so it can open any file, not just the diff. No project rules file. 3 runs per PR.
- Caught means a blocking comment that names the bug; a question or a suggestion doesn't count. Rules written: graded by a second model against an answer key, spot-checked by hand. Rules deleted (the 18 comments that state them): one run per bug, three for the two misses, graded by hand.

## What the test doesn't cover

- **A toy service and small PRs.** Real PRs are bigger, and rules sit in other repos or old chat threads. Real catch rates are likely lower.
- **Clean written rules.** Here each rule is one accurate sentence. Real comments are often vague or out of date.
- **One model, one date.** A snapshot, not a ranking of tools.

## Decision

Keep the AI reviewer on every PR. Write down the rules each change depends on, next to the code, and as a test where you can. The reviewer then checks what you wrote.

## Trade-off

The reviewer costs 3 to 4 cents per small PR (API list price); bigger PRs cost more. The rules cost writing: someone has to turn team knowledge into sentences and tests, and keep them true. A wrong comment now misleads the humans and the bot.

## Principle

A reviewer, human or AI, can only check the rules you wrote down.

Which rule in your codebase exists only in someone's head?

Code, the 20 pull requests and full results: https://github.com/archemist-dev/labs/tree/main/05-ai-review

Credit: Claude Code documentation (headless mode, code review). The test, words and numbers are mine.
