---
title: "Why Your Inserts Slow Down as the Table Grows, and How to Fix It"
description: "Your UUID primary key works fine today. Until the table grows. In my test, at 10 million rows, inserts got 14x slower. The fix was another UUID."
pubDate: "2026-10-27"
pillar: "under-the-hood"
cover: "./cover.png"
coverAlt: "Title: Same UUID, 14x faster inserts. Same 16 bytes, different order. Line chart, inserts per second up to 10 million rows on PostgreSQL 18: UUIDv7 ends at 93k per second, UUIDv4 falls to 6.6k. Archemist logo in the corner."
linkedin: "https://www.linkedin.com/pulse/why-your-inserts-slow-down-table-grows-how-fix-javlon-tulkinov-ihvof"
labs: "https://github.com/archemist-dev/labs/tree/main/03-uuid-keys"
draft: false
---

Your UUID primary key works fine today. Until the table grows. In my test, at 10 million rows, inserts got 14x slower. The fix was another UUID.

A food-delivery platform started the simple way: one shared auto-increment counter for order IDs. It stopped fitting for three reasons. Some flows needed the ID before the insert. Sequential IDs in URLs were guessable and showed how many orders there were. And other services kept their own tables with the order ID, where IDs collided.

Random UUIDs (v4) fixed all three. Any service could make one with no coordination. They stayed for years. Then the tables grew:

- Inserts got slower, with no slow query to point at.
- The indexes got big and stopped fitting in memory. And a 16-byte key is copied into every table and index that holds an order ID.
- A random ID has no order, so "newest first", pagination and following one order through the logs were harder than they had to be.

The move to time-ordered IDs (UUIDv7) made inserts steadier, and sorting by ID worked again.

Most teams pick UUIDv7 because it sorts by time. That's the nice part. The real win is in the index.

## The result

I loaded the same 10 million order rows into PostgreSQL three times. Only the ID changed: a counter, a random UUID (v4) and a time-ordered UUID (v7).

![Line chart, inserts per second against rows in the table, up to 10 million rows, PostgreSQL limited to 512 MB: bigint ends at 204k per second, UUIDv7 at 93k, UUIDv4 falls to 6.6k.](/articles/uuid-keys/3-insert-rate.png)

At the start, all three were fast. By 10 million rows, the counter inserted 204,000 rows a second, UUIDv7 93,000, and UUIDv4 6,600. Same 16 bytes as v7, 14x slower.

## Why: where the next insert lands

A primary key is stored in a B-tree: sorted pages, oldest keys on the left, newest on the right. Every insert has to go to the page where its key belongs.

![Diagram of a primary key B-tree with 8 leaf pages, oldest to newest, 6 inserts: UUIDv4 inserts land on 6 different pages, UUIDv7 inserts all land on 1 page at the right edge.](/articles/uuid-keys/1-insert-pattern.png)

A time-ordered key always belongs at the right edge. Inserts go to the same few pages, which stay in memory.

A random key belongs anywhere, so each insert lands on a different page. When the index is small, those pages are in memory and it barely shows. When it outgrows memory, most inserts first read a page from disk, and full pages split in half, leaving half-empty pages behind.

## What's inside a UUID

UUIDv7 is still 128 bits and still unique without coordination. It just puts the time first:

![UUID layout from RFC 9562, same 128 bits. UUIDv7 example 01a17e84-e100-71c4-9e2b-5f8a1d3c6e90: the first 12 hex digits are the time, 48 bits in milliseconds, then 6 version and variant bits and 74 random bits. UUIDv4 example b42410ee-132f-42ee-9e4f-09a6485c95b8: 122 random bits and 6 version and variant bits.](/articles/uuid-keys/2-bit-layout.png)

Look at one: `01a17e84-e100-71c4-9e2b-5f8a1d3c6e90`. The first 12 hex digits, `01a17e84e100`, are the milliseconds since 1970: 27 October 2026, 18:00 UTC. The `7` after them is the version. The rest is random. So an ID made a second later sorts after this one. A v4 keeps its `4` in the same place, and everything else is random (RFC 9562).

PostgreSQL 18 makes them natively with `uuidv7()`.

## The test in detail

Each row is an order: status, price in pence, time and address, about 100 bytes. Setup: PostgreSQL 18.6 on an AWS EC2 t3.small (Frankfurt, Intel Xeon 8259CL, 2 vCPU), limited to 512 MB of memory. One client, 250,000 rows per insert statement. The table shows run 1 of four.

The memory cap is on purpose. A big server hits the same cliff, just much later, and the cap brings it down to 10 million rows. At 100 inserts a second, 10 million rows is about a day of status history or events. An orders table at 1,000 orders a day takes decades to get there.

- **bigint (counter):** 10M rows in 58 s, 204,000 inserts/s at the end, 214 MB index
- **UUIDv7:** 90 s, 93,000 inserts/s at the end, 301 MB index
- **UUIDv4:** 391 s, 6,600 inserts/s at the end, 389 MB index

UUIDv4 took 4.3x longer to load (4.2x to 6.7x across runs). By the end it inserted 14x slower than v7 (13x to 28x across the four runs), at 5% of its own starting speed. UUIDv7 slowed too, to about half its starting speed, as the table outgrew memory. But it slowed gradually. v4 fell off a cliff.

The index shows why. Same 16 bytes per key, but the v4 index is 29% bigger: its pages are 70% full, v7's are 90%. And v4 wrote about 45,000 full 8 KB pages to the write-ahead log against 49 for v7. After every checkpoint, the first change to a page logs the whole page. Random keys touch thousands of old pages. Ordered keys touch the same few.

## The cheap fixes first

Before you migrate IDs, try the cheap options.

**Give the database more memory.** It works, for a while: the cliff comes when the indexes you insert into outgrow memory, so more memory moves it further out. It doesn't remove it, and every new table and index competes for the same memory. I tested the other two common fixes:

**Leave room on each page (fillfactor 70).** No help: 514 s in run 1, 395 s in run 2, against 391 s and 398 s for plain v4. Fillfactor only applies when an index is built and when it grows at the right edge. Random inserts split full pages in half whatever it's set to. (A `REINDEX` with a lower fillfactor on a full table buys room for a while. I didn't test that.)

**Keep a bigint key, add a random public ID.** The primary key stays tidy. But the public ID needs a unique index to be looked up, and that index scatters inserts the same way: 410 s, close to plain v4. It also wrote the most write-ahead log per row, because every row now goes into two indexes.

![Bar chart, seconds to load 10 million rows: bigint 58, UUIDv7 90, UUIDv4 391, UUIDv4 with fillfactor 70 514, bigint with a public UUIDv4 410.](/articles/uuid-keys/4-levels.png)

The problem follows the random column, not the primary key. Any random value with an index pays it.

## When it matters to you

The cliff comes when the indexes you insert into outgrow memory. With 512 MB, that was a few million rows. With more memory, it comes later. And it comes sooner when several tables and indexes compete for that memory: order items, status history, events, logs.

The test is one client inserting big batches. A real service inserts a row at a time from many connections. The disk reads behind each random insert are the same, but the size of the gap will differ. Run it on your own data. The script is linked below.

A few cases the test didn't cover:

- **UUIDv7 from many services.** Their clocks differ a little, so the IDs are nearly ordered, not strictly. That should still keep inserts on the last few pages.
- **MySQL (InnoDB).** Random keys hurt more: the rows themselves are stored in primary key order, so the table scatters too, not only the index.
- **Time-split tables** (Postgres partitions or TimescaleDB). For events and logs, only the newest partition's index is written, and it stays small, even with random keys. But the time column must be part of the primary key, and a lookup by ID alone searches every partition. It fits time-series tables, not an orders table you look up by ID.
- **Other ID schemes.** ULID and KSUID are the same idea as UUIDv7, without the standard. Snowflake-style IDs pack time, a worker ID and a counter into 64 bits: ordered and only 8 bytes, but each generator needs a unique worker ID, and JSON must carry them as strings. Hi/lo blocks hand out ranges from a counter, so services ask the database once per thousand IDs.

## Decision

Start simple, and change only when you need to.

1. **Start with a bigint counter.** If only the database creates IDs, stop here. Half the size, fastest inserts.
2. **IDs made outside the database?** (another service, the app before the insert, an offline client) Use UUIDv7, not v4.
3. **Creation time must stay hidden?** UUIDv7 shows it to anyone who sees the ID. Add a separate random ID for the outside world, and accept that its index pays the random cost from the test, on that one column.

## Trade-off

UUIDv7 gives you IDs made anywhere, without asking the database, and inserts much closer to counter speed than v4. It costs 16 bytes against 8 in every table and index that holds the ID. It shows when each record was created. Its order across services is only as good as their clocks. And under very high insert concurrency, the right edge becomes a hot spot: every insert wants the same page.

## Principle

A primary key is a write pattern, not just a name.

Which ID type do your primary keys use, and would you pick it again? Tell me in the comments.

Code and full results: https://github.com/archemist-dev/labs/tree/main/03-uuid-keys

Credit: RFC 9562, "Universally Unique IDentifiers (UUIDs)"; PostgreSQL 18 documentation (UUID functions, CREATE INDEX). The words, test and numbers are mine.
