#!/usr/bin/env python3
"""The bots' common words (README.md, "Bots"): the dictionary's keys that people actually use, most frequent first.

Bots pick their words from this list only; the full list (he-v1) still decides what is legal for everyone. It is the
keys of `he-v1` that appear in FrequencyWords' Hebrew list (OpenSubtitles 2018, by Hermit Dave, CC-BY-SA 4.0:
https://github.com/hermitdave/FrequencyWords, content/2018/he/he_50k.txt), in that list's order, final forms written
as regular letters, so the bots can take the top N for a level. Being derived from FrequencyWords, the output is
CC-BY-SA 4.0 too.

    python3 -I scripts/build_common.py he_50k.txt dictionary/he-v1.txt.gz dictionary/common-he-v1.txt.gz
"""
import gzip
import re
import sys

FINALS = str.maketrans('ךםןףץ', 'כמנפצ')


def main(frequency, dictionary, out):
    with gzip.open(dictionary, 'rt', encoding='utf-8') as f:
        base = set(f.read().split())
    keys, seen = [], set()
    with open(frequency, encoding='utf-8') as f:
        for line in f:
            parts = line.split()
            if not parts:
                continue
            key = parts[0].translate(FINALS)
            if re.fullmatch('[א-ת]{3,15}', key) and key in base and key not in seen:
                seen.add(key)
                keys.append(key)
    with gzip.open(out, 'wt', encoding='utf-8', compresslevel=9) as f:
        f.write('\n'.join(keys) + '\n')
    print(f'{len(keys)} common keys of {len(base)} → {out}')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
