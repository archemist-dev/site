---
title: "Your Table Grows While Nobody Inserts"
description: "At a marketplace app, writes stopped one day. The managed database had switched itself to read-only because its disk was full, and no traffic chart explained why. Most of that space had been taken by searches, and searches only read."
pubDate: "2026-11-23"
pillar: "under-the-hood"
cover: "./cover.png"
coverAlt: "Nobody inserted. The table grew 2.8x. One slow read for 60 minutes, then disk full and the database read-only. The table file drawn as 4 MB boxes: before, 120 MB of rows; after, 337 MB with 210 MB of it empty."
linkedin: "https://www.linkedin.com/pulse/your-table-grows-while-nobody-inserts-javlon-tulkinov-tumsf/"
labs: "https://github.com/archemist-dev/labs/tree/main/08-table-bloat"
draft: false
---

At a marketplace app, writes stopped one day. The managed database had switched itself to read-only because its disk was full, and no traffic chart explained why. Most of that space had been taken by searches, and searches only read.

That's the belief this piece breaks: a report only reads, so it can't hurt the database. I held one open for an hour on a busy Postgres table. The table grew from 120 MB to 337 MB, and the space stayed after the report ended.

## Every update leaves a copy behind

Postgres lets readers and writers use the same rows at the same time without waiting for each other. It does that by keeping old versions of rows (MVCC). An UPDATE doesn't change a row in place: it writes a new version and leaves the old one behind, dead. Take one order: PLACED, then COOKING, then PICKED_UP, then DELIVERED. That's four versions on disk, and three of them are dead.

Cleanup, called vacuum, removes dead versions, but only the ones no running query could still need. A query reads the database as it was when it started (its snapshot), so every version that died after that moment has to stay until the query ends. Autovacuum runs vacuum in the background, and on a busy table it keeps up all day. One slow query is enough to stop it.

<picture>
<source media="(prefers-color-scheme: dark)" srcset="/articles/table-bloat/1-versions.png">
<img src="/articles/table-bloat/1-versions-light.png" alt="Old row versions left by updates, per minute. Before the report starts, cleanup removes them. After it starts, they pile up, about 30,000 a minute, kept until the report ends.">
</picture>

## One report, one hour

The test: an `orders` table with 1M rows (120 MB, an index on `status`) and 500 status updates a second, a busy app at a modest scale. Autovacuum was tuned to keep up, and it did: with nothing else running, the table went from 120 to 122 MB in an hour.

Then one report read the table once and kept its snapshot open for an hour, like a slow admin search or an export that takes its time.

Autovacuum ran 235 times during that hour. It removed nothing. Every status change made after the report started left a dead version that had to stay: about 1.8M of them by the end.

<picture>
<source media="(prefers-color-scheme: dark)" srcset="/articles/table-bloat/2-growth.png">
<img src="/articles/table-bloat/2-growth-light.png" alt="One report open for 60 minutes at 500 order updates a second: old row versions climb to 1.8M while cleanup runs 235 times and cleans nothing. With no long report, they stay steady.">
</picture>

The table grew from 120 to 337 MB and its indexes from 28 to 61 MB. With nothing held, they ended at 122 and 35.

The growth is updates per second times the time held, not a share of the table: here about 215 MB an hour, whatever the table's size. On a 50 GB table that's under 1% an hour; on the small, hot table every request touches, it nearly tripled the file. And it isn't one table: while the snapshot is held, cleanup stops on every table in that database.

## The report ended. The space stayed.

Within a minute of the report ending, autovacuum removed the dead rows. The file didn't shrink. Vacuum marks the space as free for new rows of the same table; it doesn't give it back to the disk. The file was still 337 MB, and 210 MB of it was empty.

Empty space still gets read. Postgres stores a table in 8 KB pages, and a scan reads every page, empty or not. A filter on an unindexed column, the kind an admin panel runs, read 43,080 pages instead of 15,589 and took about 3x as long. A lookup by id didn't notice: 7 pages before and after. Scans and range filters pay; point lookups don't.

<picture>
<source media="(prefers-color-scheme: dark)" srcset="/articles/table-bloat/4-after.png">
<img src="/articles/table-bloat/4-after-light.png" alt="The orders table file drawn as 4 MB boxes. No long report: 122 MB, all pages with rows, a scan reads 15,589 pages. After the report: 337 MB, 210 MB of it empty pages that are still read, a scan reads 43,080 pages.">
</picture>

## How a search took the database read-only

Back to the marketplace app. An internal admin panel let staff combine filters freely. Some filters hit columns with no fitting index, so a search could run for minutes, on the primary database. Nobody saw a search as a risk: it only reads. While those searches ran, cleanup couldn't remove old row versions, and the busiest tables kept growing.

It showed up as disk growth that no traffic chart explained. Nothing broke yet; the bloat was slow and quiet. Then a heavy schema change was run, an ALTER TABLE that rewrites the table and needs room for a second copy. The database ran short of storage and switched itself to read-only, as many managed databases do to protect the data. Writes stopped until space was freed.

Short term, the space was taken back: vacuum, then a full table rewrite to return it to the disk, run outside busy hours because the rewrite locks the table. Long term, the indexes behind the admin filters were refined, so searches finish quickly and stop holding cleanup back.

## It doesn't have to be a slow query

Anything that holds an old snapshot does the same:

- **An idle open transaction.** A session runs `BEGIN`, reads, then waits for something else. In the test, an idle transaction at REPEATABLE READ grew the table exactly as much as the running report. At the default READ COMMITTED, a read-only transaction holds nothing between statements; one that has written something holds cleanup back until it ends.
- **A backup.** `pg_dump` reads everything in one snapshot, for as long as the dump takes.
- **A forgotten replication slot or prepared transaction.** Both hold old versions until someone removes them.
- **A replica.** More on that below.

## The cheap fixes first

I ran each fix against the same load, with the snapshot held for 10 minutes. With nothing held, the table grew 2 MB. A slow report or an idle transaction grew it 36 MB.

<picture>
<source media="(prefers-color-scheme: dark)" srcset="/articles/table-bloat/3-fixes.png">
<img src="/articles/table-bloat/3-fixes-light.png" alt="Table growth in 10 minutes, starting at 120 MB. Grows the table: a slow report on the primary +36 MB, a forgotten open transaction +36, the report moved to a replica with feedback on (the primary keeps old rows for it) +37. Stops it: ending idle transactions after 60 s +4, ending slow queries after 60 s +4, the report on a replica with feedback off +2, where the replica cancels the report. No long report: +2.">
</picture>

1. **Close idle transactions.** Set `idle_in_transaction_session_timeout` on every app role. At 60 s, the table grew 4 MB instead of 36. An idle transaction does no useful work, so this is the cheapest fix there is. On PostgreSQL 17+, `transaction_timeout` limits the whole transaction too.
2. **Limit statements per role.** A 60 s `statement_timeout` did the same for the slow report: 4 MB instead of 36. Make it short for the app and the admin panel and longer for migrations and batch jobs, per role, not for the whole server.
3. **Index what the slow reads filter on.** A timeout stops the damage; an index removes the reason. In the story, this was the real fix.
4. **Move long reports to a replica, with feedback off.** This is the trap. With `hot_standby_feedback` on, the replica tells the primary which versions its queries still need, and the primary keeps them: the primary grew 37 MB, as if the report had never moved. With feedback off, the primary grew 2 MB, and the replica cancelled the report after `max_standby_streaming_delay` (30 s by default). On a replica that serves only reports, you can raise that delay: the report finishes and the replica falls behind instead (not measured here).
5. **Send reports that run for hours to a warehouse,** fed by CDC or a nightly copy, not to the database that takes orders.

Watch for it too: alert when the oldest `backend_xmin` in `pg_stat_activity` or `pg_replication_slots` is more than a few minutes old, and on disk growth that doesn't follow traffic. If a table has already grown, `pg_repack` gives the space back without a long lock; `VACUUM FULL` does it with the table locked. (`old_snapshot_threshold`, the old escape hatch, was removed in PostgreSQL 17.)

## Decision

Limit how long any transaction can hold old row versions: an idle timeout for every app role, a statement timeout per role, and `transaction_timeout` where you run 17+. Index what the slow reads filter on. Reports that still need minutes go to a replica with feedback off; reports that need hours go to a warehouse. Alert on the oldest snapshot and on disk growth nobody can explain.

## Trade-off

Timeouts kill legitimate long work: a migration or a month-end report fails until it gets its own role and limit. A replica with feedback off cancels long reports or falls behind; with feedback on, the report is safe and the primary grows. Indexes cost write time and space on the busiest tables.

## Principle

In Postgres, a long read is a write problem.

What's the longest transaction running on your primary right now?

## How I tested

- PostgreSQL 18.7 in Docker on an AWS EC2 t3.small (eu-central-1, Intel Xeon Platinum 8259CL), Ubuntu 26.04. Autovacuum checked every 15 s and vacuumed a table once dead rows passed 2% (the defaults are 1 minute and 20%). Every variant ran twice from fresh containers; sizes matched within 1 MB.
- Pages read and sizes don't depend on the machine. Times varied up to 15% between runs, so compare the ratios, not the milliseconds.

## What the test doesn't cover

- **HOT updates.** The `status` index makes every update write new index entries. With no index on the changed column, Postgres can put the new version in the same page without new index entries (a HOT update); the indexes would grow less, but a held snapshot blocks that page's cleanup too.
- **Other rates.** The test ran 500 updates a second, with the snapshot held for 10 and 60 minutes. Double the rate or the time, and the growth roughly doubles.
- **The repair.** The test didn't measure what `pg_repack` or `VACUUM FULL` costs, or a warehouse.

## Words used here

- **Row version.** A copy of a row as it was at one moment. Every UPDATE writes a new one; the old one becomes a **dead row** once no query can see it.
- **Snapshot.** The point in time a query sees the database as of. At REPEATABLE READ, one snapshot lasts for the whole transaction.
- **Vacuum and autovacuum.** Vacuum removes dead rows and marks their space as free for the same table. Autovacuum runs it in the background.
- **VACUUM FULL and pg_repack.** Both rewrite the table into a compact file and give the space back to the disk. VACUUM FULL locks the table for the whole rewrite; pg_repack (an extension) locks it only briefly at the end.
- **hot_standby_feedback.** A replica setting: when on, the replica tells the primary which old versions its queries still need.

Code and full results: https://github.com/archemist-dev/labs/tree/main/08-table-bloat

Credit: Martin Kleppmann and Chris Riccomini (*Designing Data-Intensive Applications*, 2nd ed., 2026), PostgreSQL documentation ("Concurrency Control", "Routine Vacuuming", "Hot Standby"). The test, words and numbers are mine.
