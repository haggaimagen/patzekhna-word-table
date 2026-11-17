# רמילים — the word table of פצח־נא

The server of **רמילים** ("the word table"), a mode of the Hebrew word game
[פצח־נא](https://patzekhna.web.app). It's rummy with letters: 2–4 friends share
one board of Hebrew words. On your turn you build new words from your letters,
extend words on the board, cut them in two and move letters between them.
Every word on the board must be a real word of 3 letters or more. The first
player to place all their letters wins.

This repository holds what decides a game:
- **the rules** (`functions/src/table.js`);
- **the turns** (`functions/src/tableCallable.js`, a Firebase callable function);
- **the Hebrew dictionary** and the script that builds it.

It is published under the **GNU Affero General Public License v3**, because the
dictionary is built from [Hspell](https://hspell.sourceforge.net/), which is
AGPL. The game's apps are separate programs that talk to this server.

## The rules in short

- **Tiles:** 106 tiles: 104 Hebrew letters by how often Hebrew uses them, and 2 jokers. Each player gets 12–21 letters (14 by default).
- **Starting:** every seated player must mark themselves ready. Changing the table settings clears readiness. The host can start when at least two players are seated and all are ready; everyone sees a shared 3-second countdown before the first turn.
- **Finals:** there are no final-form tiles. ך ם ן ף ץ show by themselves at the end of a word.
- **Opening:** your first move must be worth at least 10 points of your own letters, in new words only.
- **A turn ends** with at least one of your letters placed, and every word on the board 3+ letters long, one colour (when the table plays with colours), and in the dictionary.
- **Stuck:** no move means taking a letter from the pool. When the clock runs out:
  - a good board stands;
  - a broken board goes back, and you take 3 letters;
  - if you placed nothing, you take 1 letter.
- **Asking the table:** "בקשו מהשולחן לאשר". Once a turn, you can ask the others to accept up to three words the dictionary doesn't know.
  - Your clock stops while they vote (15 seconds).
  - A word passes with a majority of everyone who may vote.
  - It then counts for that game only.

## Public players lobby

Tables start private. The host can make a waiting room public and set a 2–4
player capacity; bots take seats too. `browseLobby` returns public waiting rooms
and games in progress in `allRooms`, sorted with joinable rooms first. Full and
started rooms carry disabled statuses. `players` lists active browsers as
available and players seated in visible public rooms as busy, with
available players first. The older `rooms` and `visitors` fields still return
only joinable rooms and browser nicknames for existing app builds.
`lobbyPresence` maintains those visitors with a 45-second lease. `joinPublic`
claims a seat transactionally, with the same capacity and start checks used by
code joins. Private, expired, finished, and host-offline available rooms are hidden.
Rematches begin private. The `discoverable ASC, createdMs DESC` Firestore index
is defined in the Android app repository's `firestore.indexes.json` and must
be deployed before this function serves production traffic.

## The dictionary

`functions/dictionary/he-v1.txt.gz` holds 346,469 keys: Hebrew letters only,
final forms written as regular letters (שלום → שלומ), 3–15 letters each.
**There are no prefixed forms** (ו ה ב כ ל מ ש in front of a word): בית is in,
הבית is not.

| Source | License | What it gives |
|---|---|---|
| [Hspell](https://hspell.sourceforge.net/) 1.4, by Nadav Har'El and Dan Kenigsberg | AGPL v3 | The base: every inflected form, without prefixes by design |
| [Wikidata](https://www.wikidata.org/) Hebrew lexemes | CC0 | Inflected forms Hspell lacks |
| [Hebrew Wiktionary](https://he.wiktionary.org/) titles | CC-BY-SA 4.0 | Newer words and loanwords; a title made of ה or ו in front of a known word is left out |
| [FrequencyWords](https://github.com/hermitdave/FrequencyWords) (OpenSubtitles 2018), by Hermit Dave | CC-BY-SA 4.0 | Common spellings Hspell lacks (היתה, מוזיאון), when one י or ו away from an Hspell word; also a review list of frequent missing words |
| The game's own catalog | — | Every word the game has used |
| `dictionary/allow.txt`, `dictionary/deny.txt` | — | Decisions made by hand after review |

On top of the built list, the server reads `dictionaryLists/{env}` from
Firestore, cached for a minute. That document holds `allow` and `deny` arrays
of keys, kept by the game's admin tool from the review queue. A denied key is
never a word, and an allowed one always is, with no rebuild. Every word a table
votes on is logged once in `wordReviews/{env}/words/{key}` (its text, how many
tables asked, how many accepted, and the last vote), for that review.

To rebuild it on a Mac:

```bash
brew install hspell
cd functions
python3 -I scripts/build_dictionary.py --version 1 \
  --wiktionary hewiktionary-latest-all-titles-in-ns0.gz \
  --wikidata wikidata-forms.tsv --catalog catalog.json --frequency he_full.txt \
  --allow dictionary/allow.txt --deny dictionary/deny.txt \
  --out dictionary --hosting <folder the phones download from> --review <review folder>
```

Where the inputs come from:

| Input | Source |
|---|---|
| `hewiktionary-latest-all-titles-in-ns0.gz` | [Wikimedia dumps](https://dumps.wikimedia.org/hewiktionary/latest/) |
| `wikidata-forms.tsv` | A [Wikidata Query Service](https://query.wikidata.org/) export of `SELECT ?rep WHERE { ?l dct:language wd:Q9288; ontolex:lexicalForm ?f. ?f ontolex:representation ?rep. FILTER(LANG(?rep)="he") }` |
| `he_full.txt` | FrequencyWords' `content/2018/he` |
| `he_50k.txt` (the bots' common words, `scripts/build_common.py`) | FrequencyWords' `content/2018/he` |
| `catalog.json` | The game's published catalog |

The script prints the counts at each step and writes samples for review.

## Friends

A player can invite friends to a lobby without a code. Each player has an inbox,
`tables/{env}/inboxes/{inbox}`, where `inbox` is the SHA-256 of `table-inbox:`
followed by their device key: only their own phone can work out that address.
- The server keeps which inbox belongs to which player id in `tables/{env}/players/{id}`, which no client reads. It writes it whenever the player opens or joins a table.
- `inviteFriend {gameId, friend}` adds an invitation (the code, who sent it, when it ends) to the friend's inbox, at most 10 a minute per sender.
- `presence {mode, session}` publishes an app-wide foreground lease: `open` registers the player, `pulse` renews it, and `close` clears it on background. A lost close expires after 45 seconds. `friendPresence {friends}` returns only the IDs currently online; the apps check while the friend list or lobby is visible.

## Diamonds

A table can have a price. The game's settings (`gameTuning/{env}`, key `wordTable`: `stakes`, `freePlay`, `houseCut`, `botPrice`)
list the prices a host may pick and whether a free table is one of them. Every player pays when the game starts, and
the winner takes the pot (price × seats) less the house's cut, rounded in the house's favour. A game with no winner
gives each seat still at the table its price back. The diamonds themselves live on the phones, so every call carries
the player's `balance`. A priced table refuses a join, a ready, the host's change of price, a start and "again" with
`diamonds` when the balance is short, and with `update` when an older app sends none. The result carries `pot` and
`payouts` (per seat). `tableTuning`, `chooseStake` and `payouts` in `src/table.js`.

## Removing a player

The host can remove another player from the lobby (`kick {gameId, player}`, the player's seat id). Their seat goes,
and their id is kept in the table's `kicked` list, so the table's code refuses them from then on (`removed`). So
do "again" into that lobby and a friend's invitation to it. Only the host can do this, never to themselves, and only
in the lobby; during a game, leaving is the player's own choice. The player's app sees itself in `kicked` and says
so. Each removal is counted as `kicks` in the daily statistics. The logic is `kickSeat` in `src/table.js`.

## Bots

The host can seat bots in the lobby (`addBot {gameId, level}`, `removeBot {gameId, bot}`, `botLevel {gameId, bot,
level}`), up to the table's four seats. A bot is always ready, has a name of its own, and plays at a level from 1 to 5.
Each change of bots clears the players' readiness, as a change of settings does.

- **Where it plays:** on the server, so a phone that sleeps never stops it. There is no scheduler: when a bot's turn
  comes, the table carries `turn.botAt`, and the phones at the table call `timeout` from then on (the call that already
  ends a sleeping player's turn). The first call, 1.5 s into the turn, finds the bot's move and saves it as its `draft`
  (with `bot: true` and a window, `from`–`until`, in which the phones show its letters arriving one at a time: 1.5 s
  apart at level 1, 0.6 s at level 5). `botAt` then moves to when the move is played: the level's share of the clock
  (`turn.botThink`), or later when the letters need longer, and always before the clock runs out. That call plays it,
  logged as a `play`. A bot with no move draws a letter at its time. An app that knows nothing of bots still moves
  them, late, at the end of the clock.
- **The move finder** (`src/bots.js`): it finds new words in the hand's letters (one colour each, jokers filling in)
  and letters from the hand added to a word on the board (which may be rearranged). It does not cut words or move
  letters between words. Every move is checked by `checkPlay` like a player's, and a word StageAdmin denied is never
  played.
- **Common words only:** bots pick from `dictionary/common-he-v1.txt.gz`, not from the whole list, so they never play
  a form that is legal but nobody uses (הצטערכן). It holds the full list's keys found in FrequencyWords' Hebrew
  subtitle list (24,716 of them), most frequent first, built by `scripts/build_common.py`; the hand-added
  `allow.txt` counts as common too. Each level takes the most frequent N, indexed by letters once per instance: 4,000
  at level 1, 6,000 at 2, 10,000 at 3, 16,000 at 4 and all of them at level 5 (`botRules.pool`). An opening a level
  cannot make from its own words tries all the common words before drawing. The full list still decides what is legal
  for everyone, so the players are unaffected. Measured over 40 sample racks a setting, every level opens on its first
  turn 100% of the time with 14 letters and no colours, 95% with 12 letters and 3 colours, and 85% with 12 letters
  and 4 colours (the full list: 93%), and once open finds a play every time.
- **The levels:**

| Level | A turn | Longest word | Time it takes |
|---|---|---|---|
| 1 | its shortest word (about 3 letters) | 4 | about 70% of the clock |
| 2 | one of its best three words, up to 5 letters | 5 | about 65% |
| 3 | up to 2 moves, up to 8 letters | 5 | about 60% |
| 4 | up to 3 moves, up to 11 letters | 6 | about 55% |
| 5 | everything it can: the best of its best first moves of each length, followed through | 7 | about 50% |

  Each turn varies the time by up to ±4% of the clock. "Longest word" counts a new word, or a word on the board with
  the bot's letters added (`botRules.wordLength`). Every level makes the first-turn minimum when its letters allow:
  the lower levels with the fewest letters that make it, and when words within the level's length cannot make it,
  the length is lifted for that opening only.
- **Diamonds:** bots never pay and never collect. The pot is the price × the human seats. A table of the host and bots
  only costs the host a flat price instead (`gameTuning/{env}` key `wordTable`, `botPrice`, 0–1000, 10 by default),
  paid at the start, with no pot. When a bot finishes first at a priced table, the house keeps the whole pot
  (`stakeRules.botWin`; counted in `diamondsCut`).
- **Votes:** bots do not vote, and against bots only there is nobody to ask (`no-voters`).
- **The end:** when no human is left in a game, it ends.
- **Statistics:** `botsAdded`, `botGames`, `botOnlyGames`, `botLevels.{1–5}`, `botPlays`, `botTiles`, `botDraws`,
  `botWins`, `botTableDiamonds`. Bots are not counted under `platforms` or `diamondsStaked`.

The function runs with 512 MiB for the index.

## Statistics

Aggregated only, never per player. The function adds counters to one document a
day, `tableStats/{env}/days/{yyyy-mm-dd}` in Israel time, inside the same
transaction as the move it counts (`functions/src/stats.js`): tables opened and
joined, games started and finished and how they ended, turns by kind, letters
played, refused plays by reason, votes and their results, and the settings and
platforms of the games started, the price of a seat, and the diamonds staked, paid out and kept as the house's cut. A retried transaction starts a new tally, so
nothing counts twice. No client can read these documents.

## How long things are kept

Every write moves `expireAt` 30 days ahead on a table, its hands, its private state
and its code; a player's inbox record keeps for a year. A Firestore TTL policy on
`expireAt` deletes what has expired.

New clients send `tablePulse` while a table is on screen. Its human seat has a
five-minute lease; backgrounding stops renewal but allows a brief return. The
`sweepTables` scheduled function runs each minute, drops expired seats, closes an
empty lobby, and finishes a game when no humans remain. Older clients have no
table lease: a turn stalled for ten minutes is hidden from lobby browsing and
finished by the sweep. A full waiting room also requires an online host to stay
listed. New clients persist failed `leave` calls and retry them before opening
another table; `managed` calls reserve one active table per player and return
the existing table and hand for a Resume or Leave choice.

## Running it

```bash
cd functions && npm install && npm test
```

The emulator tests need Java:

```bash
firebase emulators:exec --only functions,firestore "cd functions && FUNCTIONS_EMULATOR_PORT=5021 node --test test/table.emulator.js"
```

Deploy (the `table` codebase of the game's Firebase project):

```bash
firebase deploy --only functions:table,functions:sweepTables
```

## License

GNU Affero General Public License v3 only (see `LICENSE`).
- **The dictionary:** derived from Hspell (AGPL v3), and includes data from Wikidata (CC0), Hebrew Wiktionary (CC-BY-SA 4.0) and FrequencyWords (CC-BY-SA 4.0), with thanks to all of them.
- **The bots' common words** (`dictionary/common-he-v1.txt.gz`): derived from FrequencyWords by Hermit Dave (OpenSubtitles 2018, https://github.com/hermitdave/FrequencyWords), CC-BY-SA 4.0, and shared under the same licence.
- **Running a changed version:** if you run a modified version of this server for others over a network, the AGPL asks you to offer them its source.
