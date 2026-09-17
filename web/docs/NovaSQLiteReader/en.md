# Nova SQLite Reader

Opens a SQLite database **read-only** and returns one table as a `NOVA_TABLE`
payload, ready for Nova Tag Writer.

## Start here if you don't have a database

That is the normal starting point. You do not need to know SQL, and you do not
need to build anything.

**1. Copy the example.** This pack ships one:

```
examples/nova_album_example.db
```

Copy it somewhere of your own — `~/Databases/my_album.db`, anywhere. Work on the
copy, not the file in the pack, or an update will overwrite it.

**2. Point `database_path` at your copy** and set `table_name` to `albums`.
Leave `columns` as `*`, set `column_set` to `tags`, and run. Three example rows
come back. Nothing has touched your audio yet — this node only reads.

**3. Replace the rows with yours.** Install
[DB Browser for SQLite](https://sqlitebrowser.org) — free, open-source, on every
platform. Open your copy, click Browse Data, and edit the cells like a
spreadsheet. One row per audio file. **`FileName` must match the file on disk**;
that is how a row finds its file. Everything else is metadata you choose.
Click Write Changes when you are done.

The example table carries both families of column: the tag names Nova Tag Writer
writes (`Title`, `Artist`, `Album`, `Track Number` …) and the field names Nova
Master Identity reads (`track_title`, `isrc`, `catalog_number` …). Keep the ones
you use and delete the rest — `column_set` selects the right family either way,
and a column a preset asks for that your table doesn't have is skipped, not an
error.

## Your first line of SQL, whether you meant to write one or not

The `where` box takes one expression. That expression is SQL, and it is the only
SQL this node ever needs from you:

```
Album = 'Example Album'
```

That reads: *give me the rows whose Album column equals this text.* Single quotes
around text, none around numbers. From there, everything below is the same idea
with more words — `AND`, `OR`, `LIKE '%partial%'`, `IN (...)`, `BETWEEN`. The
console line after each run tells you how many rows came back, which is the only
feedback you need to know whether the filter did what you meant.

Getting this wrong cannot damage anything. The database is opened read-only, and
the node rejects anything that writes.

![The reader and loader feeding Nova Tag Writer](images/tag-chain.png)
*The grey text in the `where` box is the placeholder, not a filter — this run
returned all 6 rows of `album01`. See "The placeholder is not a value" below.*

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `database_path` | empty | Full path to an existing `.db`. |
| `table_name` | `albums` | The table to read. |
| `columns` | `*` | `*` or a comma-separated list. |
| `where` | empty | Raw SQL filter, without the `WHERE` keyword. |
| `new_database_folder` | empty | Used **only** when `database_path` is empty. |
| `new_database_name` | empty | Creates an empty database and returns 0 rows. |

## Outputs

`table`, `record_count`, `column_count`, and `column_headers` — a genuine
ComfyUI list output, one string per column, so it fans out to list-aware nodes.

## The placeholder is not a value

The `where` box shows greyed example text:

    Artist = 'crazy gecko' AND Genre LIKE '%Metal%'

That is a hint, not content. While it looks filled in the field is empty and
every row is returned. Click in and type to make it real.

## `column_set` — stop typing column lists

A preset that fills in the columns for you. It applies **only while `columns` is
`*` or empty**; type a column list and that always wins, so the preset is a
convenience, never a constraint.

| Preset | Selects |
|---|---|
| `custom` | whatever `columns` says (the original behaviour) |
| `tags` | the columns Nova Tag Writer writes: FileName, Title, Artist, Album, Track Number, Date, Genre, Comment, Copyright, EncodedBy, Lyrics and friends |
| `identity` | the columns that map onto Nova Master Identity |

A preset names what it would *like*. Columns your table does not have are
skipped rather than raising, so the same preset works across databases with
different schemas.

## `identity_json` — populate Nova Master Identity from the catalogue

Set `column_set` to `identity`, narrow `where` to one song, and wire
`identity_json` into **Nova Master Identity**'s `identity_fields_json` input.
Every field it carries replaces the widget of the same name, so the database is
the single source of truth and nothing has to be retyped after a browser reset
or a reloaded graph.

```
where:  Title = 'Nine Hours North'
->      { "track_title": "Nine Hours North", "artist_name": "crazy gecko",
          "album_title": "High Water Sessions", "track_number": 5,
          "release_year": 2026, "copyright_owner": "..." }
->      archive_name  05_CG_Nine-Hours-North_Master_24-48.wav
```

### A column named exactly like an Identity field wins

A table can legitimately carry both families — `Copyright` holding the full
notice a player displays and `copyright_owner` holding just the owner,
`Comment` holding the public blurb and `notes` holding the mastering note. A
column named exactly like an Identity field is a deliberate statement, so it is
read first; tag columns only fill fields the exact ones left empty. A table with
no exact columns still populates everything through the tag names.

Column names are otherwise matched ignoring case and punctuation, so `Track
Number`, `track_number` and `TrackNo` are the same column. Recognised names include
Title, Artist, Album, Track Number, Version, Date/Year, ISRC, Catalog Number,
UPC/EAN, Publisher, Label, Composer, Producer, Mix Engineer, Mastering Engineer,
Copyright, Work ID/ISWC, Project, Territory, Language, Explicit, Client
Reference and Comment. A table built for this node can also just use Identity's
own field names. Anything unrecognised is ignored rather than guessed at.

`Date` values are read for their year (`2026-09-11` → `2026`) and `Track Number`
tolerates `5/12`. `target_bit_depth` and `target_sample_rate` feed combo widgets,
so they are reduced to their digits and checked against the allowed values —
`24-bit` → `24`, `48000 Hz` → `48000`, anything else leaves the widget alone.
Blank cells are left out entirely, so a database gap never clears a field you
filled in by hand.

**The identity preset insists on exactly one row.** Silently taking the first of
six is how the wrong song ends up carrying a catalogue number, so a query that
matches several stops with the list of titles it found. In `tags` or `custom`
mode `identity_json` is simply `{}` and many rows are fine.

## What `where` allows

Raw SQL, so AND / OR / LIKE / IN / BETWEEN all work — but it is screened. No
`;`, and none of ATTACH, ALTER, CREATE, DELETE, DROP, INSERT, PRAGMA, REPLACE,
UPDATE or VACUUM. Table and column names are checked against the live schema and
quoted, never interpolated into the statement.

## A missing database is an error, not a silent create

Pointing `database_path` at a path that does not exist fails rather than
creating one. A typo should not scatter empty databases across your disk. When
you genuinely want a new database, leave `database_path` empty and fill in
`new_database_folder` + `new_database_name` instead — that returns 0 rows, which
is the honest answer for an empty table.

## Notes

- The database is opened read-only. This node cannot modify your data.
- Column order follows `columns`, or the table's own order when it is `*`.
- Wire `column_headers` into Nova Console to see the schema you actually got.
