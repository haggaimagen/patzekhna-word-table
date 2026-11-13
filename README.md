# שולחן מילים — the word table of פצח־נא

The server of **שולחן מילים** ("the word table"), a mode of the Hebrew word game
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

- **Tiles:** 106 tiles: 104 Hebrew letters by how often Hebrew uses them, and 2 jokers. Each player gets 7–21 letters (14 by default).
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
| `catalog.json` | The game's published catalog |

The script prints the counts at each step and writes samples for review.

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
firebase deploy --only functions:table
```

## License

GNU Affero General Public License v3 only (see `LICENSE`).
- **The dictionary:** derived from Hspell (AGPL v3), and includes data from Wikidata (CC0), Hebrew Wiktionary (CC-BY-SA 4.0) and FrequencyWords (CC-BY-SA 4.0), with thanks to all of them.
- **Running a changed version:** if you run a modified version of this server for others over a network, the AGPL asks you to offer them its source.
