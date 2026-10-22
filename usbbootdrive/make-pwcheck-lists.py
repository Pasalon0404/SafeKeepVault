#!/usr/bin/env python3
# =====================================================================
#  make-pwcheck-lists.py — build pwcheck-lists.json from zxcvbn's lists
# =====================================================================
#  The password strength check (safekeep-pwcheck.py on the stick, and
#  shared/pwcheck.js in the app) reads its word lists from
#  pwcheck-lists.json. This script makes that file from zxcvbn 4.4.2's
#  frequency lists (MIT licence, Dan Wheeler and Dropbox, Inc.) and the
#  BIP39 English wordlist. It only needs re-running to change the lists.
#
#  Usage (on any computer with npm and Python 3):
#     npm pack zxcvbn@4.4.2 && tar xzf zxcvbn-4.4.2.tgz
#     python3 make-pwcheck-lists.py package/lib/frequency_lists.js \
#         ../seed-xor-tool/node_modules/@scure/bip39/wordlists/english.js
# =====================================================================
import json
import re
import sys

# Each list is cut to (at most) its most common entries, to keep the app small.
# Order matters: when a word is in several lists, the check names the
# first list that ranks it best.
KEEP = [
    ("passwords", 30000),
    ("english_wikipedia", 20000),
    ("us_tv_and_film", 10000),
    ("surnames", 5000),
    ("female_names", 2000),
    ("male_names", 2000),       # zxcvbn has 983
]


def main(freq_path, bip39_path):
    src = open(freq_path, encoding="utf-8").read()
    lists = {}
    for name, keep in KEEP:
        m = re.search(r"\b" + name + r': "([^"]*)"', src)
        if not m:
            sys.exit(f"{name} not found in {freq_path}")
        # The lists are JavaScript strings: undo the one escape they use.
        words = m.group(1).replace("\\'", "'").split(",")
        lists[name] = ",".join(words[:keep])

    words = re.findall(r"[a-z]+", open(bip39_path, encoding="utf-8").read().split("`")[1])
    if len(words) != 2048:
        sys.exit(f"expected 2048 BIP39 words, found {len(words)}")
    lists["bip39"] = ",".join(words)

    out = {
        "_about": "Word lists for the SafeKeep password strength check. Made by "
                  "usbbootdrive/make-pwcheck-lists.py from zxcvbn 4.4.2's frequency "
                  "lists and the BIP39 English wordlist.",
        "_license": "zxcvbn lists: MIT licence, Copyright (c) 2012-2016 Dan Wheeler and "
                    "Dropbox, Inc. BIP39 wordlist: MIT licence, from BIP-0039.",
        "lists": lists,
    }
    with open("pwcheck-lists.json", "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=True)
        f.write("\n")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: make-pwcheck-lists.py <zxcvbn frequency_lists.js> <bip39 english wordlist .js>")
    main(sys.argv[1], sys.argv[2])
