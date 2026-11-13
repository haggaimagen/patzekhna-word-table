#!/usr/bin/env python3
"""Builds the word table's dictionary (README.md, "The dictionary", "Building the list").

  brew install hspell
  python3 -I scripts/build_dictionary.py --version 1 --wiktionary <titles.gz> --wikidata <forms.tsv> \
      --catalog <catalog.json> --frequency <he_full.txt> --out dictionary --hosting <hosting/public/dict> \
      --review <folder>

The list holds lookup keys, one per line, sorted: Hebrew letters only, final forms written as regular
letters (שלום → שלומ), 3–15 letters, and never a word with a prefix (ו ה ב כ ל מ ש) in front.

Sources:
- Hspell (AGPL v3): every inflected form, without prefixes by design: Hspell adds them at lookup time.
- Wikidata Hebrew lexemes (CC0) and Hebrew Wiktionary titles (CC-BY-SA 4.0): newer words Hspell lacks.
  A supplement word made of prefix letters in front of a word the list already has is left out.
- The game's catalog (stages and dailies): every word the game has used.
- FrequencyWords (CC-BY-SA 4.0): never added; its frequent words that the list lacks go to a review file.
- Optional allow and deny files (one word per line), for decisions made in review.
"""
import argparse
import gzip
import hashlib
import json
import random
import re
import sys
from pathlib import Path

HSPELL = Path('/opt/homebrew/share/hspell/hebrew.wgz')
FINALS = str.maketrans('ךםןףץ', 'כמנפצ')
POINTS = re.compile('[֑-ׇ]')
LETTERS = re.compile('^[א-ת]+$')
PREFIX_LETTERS = set('והבכלמש')
MIN_LETTERS, MAX_LETTERS = 3, 15


def key(word, shortest=MIN_LETTERS):
    """The lookup key, or None for anything that is not a plain Hebrew word of the right length."""
    word = POINTS.sub('', word.strip()).replace('־', '-')
    if not LETTERS.match(word):
        return None
    word = word.translate(FINALS)
    return word if shortest <= len(word) <= MAX_LETTERS else None


TO_FINAL = {'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ'}


def shown(k):
    """A key as people write it, with its final letter, for the review files."""
    return k[:-1] + TO_FINAL.get(k[-1], k[-1]) if len(k) > 1 else k


def hspell_words(path=HSPELL):
    """Hspell's word list: a gzip of ISO-8859-8 letters, where a number n means "this word ends here; take n
    letters off before the next one". Checked against hebrew.wgz.prefixes, which holds one byte per word."""
    data = gzip.open(path).read()
    words, current, back, pending = [], bytearray(), 0, False
    for byte in data:
        if 48 <= byte <= 57:
            back, pending = back * 10 + byte - 48, True
            continue
        if pending:
            words.append(current.decode('iso-8859-8'))
            del current[max(0, len(current) - back):]
            back, pending = 0, False
        current.append(byte)
    if current:
        words.append(current.decode('iso-8859-8'))
    expected = len(gzip.open(str(path) + '.prefixes').read())
    if len(words) != expected:
        sys.exit(f'Hspell decode gave {len(words)} words, its prefix file says {expected}')
    return words


def prefixed(word, known):
    """True when the word is prefix letters (up to three, as in וכשה) in front of a word already known."""
    for cut in range(1, 4):
        head, rest = word[:cut], word[cut:]
        if not set(head) <= PREFIX_LETTERS or len(rest) < 2:
            break
        if rest in known:
            return True
    return False


def definite_or_and(word, known):
    """A dictionary title that is ה (the) or ו (and) in front of a word already known, like התיק or והבית.
    Hitpa'el verbs start with הת and are words of their own (התלקט), so they stay. Titles starting with
    ב כ ל מ ש are kept: in Wiktionary those are mostly words of their own (בבקשה, בימאי, ברכים)."""
    if word[0] not in 'הו' or word.startswith('הת'):
        return False
    return len(word) >= 4 and word[1:] in known


def spelling_variants(word):
    """The spellings one י or ו away: היתה → הייתה, מוזיאון → מוזאון, מצויין → מצוין."""
    out = set()
    for i, c in enumerate(word):
        if c in 'יו':
            out.add(word[:i] + word[i + 1:])
    for i in range(1, len(word)):
        for c in 'יו':
            out.add(word[:i] + c + word[i:])
    return out


def read_lines(path):
    return [line.strip() for line in Path(path).read_text(encoding='utf-8').splitlines()
            if line.strip() and not line.startswith('#')]


def main():
    args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    args.add_argument('--version', type=int, required=True)
    args.add_argument('--wiktionary', required=True, help='hewiktionary-latest-all-titles-in-ns0.gz')
    args.add_argument('--wikidata', required=True, help='SPARQL TSV of Hebrew lexeme form representations')
    args.add_argument('--catalog', required=True, help='catalogs/production as the Firestore REST API returns it')
    args.add_argument('--frequency', required=True, help='FrequencyWords he_full.txt')
    args.add_argument('--allow', help='extra words to add, one per line')
    args.add_argument('--deny', help='words to remove, one per line')
    args.add_argument('--out', required=True, help='the functions folder for he-v{N}.txt.gz')
    args.add_argument('--hosting', required=True, help='the Hosting folder the phones download from')
    args.add_argument('--review', required=True, help='a folder for the review files')
    a = args.parse_args()

    counts = {}
    raw = hspell_words()
    base = {k for k in map(key, raw) if k}
    # Short words too, only to recognise a prefix in front of one (ש+זה, ב+כל); they are not in the list.
    stems = {k for k in (key(w, 2) for w in raw) if k}
    counts['hspell'] = (len(raw), len(base))

    def supplement(name, words, check_prefix):
        kept, dropped = set(), set()
        for word in words:
            k = key(word)
            if not k or k in base:
                continue
            (dropped if check_prefix(k) else kept).add(k)
        counts[name] = (len(kept), len(dropped))
        return kept, dropped

    titles = gzip.open(a.wiktionary, 'rt', encoding='utf-8').read().splitlines()
    wiktionary, wiktionary_dropped = supplement('wiktionary', (t.replace('_', ' ') for t in titles),
                                                lambda k: definite_or_and(k, stems))
    forms = [line.split('"')[1] for line in Path(a.wikidata).read_text(encoding='utf-8').splitlines() if line.count('"') >= 2]
    # A Wikidata form is an inflection of an entry, so it never carries a prefix: no filter.
    wikidata, wikidata_dropped = supplement('wikidata', forms, lambda k: False)

    payload = json.loads(json.loads(Path(a.catalog).read_text())['fields']['payload']['stringValue'])
    catalog_words = {w['word'] for s in payload.get('allStages', []) + payload.get('stages', [])
                     for w in s.get('words', []) if isinstance(w.get('word'), str)}
    catalog_words |= {d['word'] for d in payload.get('daily', []) if isinstance(d.get('word'), str)}
    catalog = {k for k in map(key, catalog_words) if k}
    counts['catalog'] = (len(catalog), len(catalog - base))

    allow = {k for k in map(key, read_lines(a.allow)) if k} if a.allow else set()
    deny = {k for k in map(key, read_lines(a.deny)) if k} if a.deny else set()
    # Common spellings Hspell lacks: forms people write often (50+ times in the subtitles) that are one
    # י or ו away from a word in the list, and not a prefix in front of a known word.
    frequency = []
    for line in Path(a.frequency).read_text(encoding='utf-8').splitlines():
        word, _, count = line.rpartition(' ')
        if count.isdigit():
            frequency.append((int(count), word))
    so_far = base | wiktionary | wikidata | catalog
    seen = {}
    for count, word in frequency:
        k = key(word)
        if k:
            seen[k] = seen.get(k, 0) + count
    # A real second spelling is used alongside the first (היתה 81K, הייתה 167K). A name that merely looks like
    # a word is far more common than it (סאם against סיאם), so a variant may be at most 10 times its neighbour.
    variants = set()
    for k, count in seen.items():
        if count < 50 or k in so_far or prefixed(k, stems):
            continue
        neighbours = spelling_variants(k) & base
        if neighbours and count <= 10 * max(seen.get(n, 0) for n in neighbours):
            variants.add(k)
    counts['variants'] = len(variants)

    words = (base | wiktionary | wikidata | catalog | variants | allow) - deny
    counts['allow'], counts['deny'] = len(allow), len(deny)
    counts['total'] = len(words)

    # Frequent words people write that the list lacks: for review, never added here.
    missing = []
    known = stems | words
    for count, word in frequency:
        if count < 20:
            continue
        k = key(word)
        if k and k not in words and not prefixed(k, known):
            missing.append((count, word))
    counts['missing'] = len(missing)

    ordered = sorted(words)
    text = ('\n'.join(ordered) + '\n').encode('utf-8')
    digest = hashlib.sha256(text).hexdigest()
    name = f'he-v{a.version}'
    manifest = {'version': a.version, 'name': name, 'words': len(ordered), 'sha256': digest,
                'minLetters': MIN_LETTERS, 'maxLetters': MAX_LETTERS,
                'sources': {'hspell': '1.4 (AGPL v3)', 'wikidata': 'Hebrew lexeme forms (CC0)',
                            'wiktionary': 'hewiktionary titles (CC-BY-SA 4.0)', 'catalog': 'patzekhna'},
                'counts': counts}
    for folder in (Path(a.out), Path(a.hosting)):
        folder.mkdir(parents=True, exist_ok=True)
        with gzip.GzipFile(folder / f'{name}.txt.gz', 'wb', mtime=0) as out:
            out.write(text)
        (folder / f'{name}.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    # The phones download it plain: Hosting compresses it on the way, and the app searches the sorted lines in place.
    (Path(a.hosting) / f'{name}.txt').write_bytes(text)
    (Path(a.hosting) / f'{name}.txt.gz').unlink(missing_ok=True)

    review = Path(a.review)
    review.mkdir(parents=True, exist_ok=True)
    rng = random.Random(a.version)
    def sample(keys):
        return '\n'.join(shown(k) for k in sorted(rng.sample(sorted(keys), min(200, len(keys))))) + '\n'
    (review / 'kept-sample.txt').write_text(sample(ordered))
    (review / 'dropped-prefixed-sample.txt').write_text(sample(wiktionary_dropped | wikidata_dropped))
    (review / 'added-by-supplements-sample.txt').write_text(sample((wiktionary | wikidata) - base))
    (review / 'spelling-variants.txt').write_text('\n'.join(shown(k) for k in sorted(variants)) + '\n')
    (review / 'catalog-not-in-hspell.txt').write_text('\n'.join(shown(k) for k in sorted(catalog - base)) + '\n')
    (review / 'missing-frequent.txt').write_text(''.join(f'{w}\t{c}\n' for c, w in sorted(missing, reverse=True)[:500]))
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
