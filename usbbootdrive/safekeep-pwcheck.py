#!/usr/bin/env python3
# =====================================================================
#  safekeep-pwcheck.py — password strength check (on the stick)
# =====================================================================
#  A line-by-line port of seed-xor-tool/shared/pwcheck.js, which explains
#  the method. That copy draws the bar in the app; this one enforces the
#  rule: setup-vault.sh refuses a Weak Master Passphrase, and the backup
#  watcher in safekeep-boot.sh refuses a Weak Encrypted Backup password.
#  test-pwcheck.mjs requires both copies to give the same bits, band and
#  reasons. Change both together.
#
#  Usage:
#     printf '%s' "$PASSWORD" | safekeep-pwcheck.py vault|backup
#        → one line of JSON: {"bits", "band", "reasons", "message"}
#     printf '%s' "$PASSWORD" | safekeep-pwcheck.py --lines vault|backup
#        → three lines, for bash: band, whole bits, message
#     safekeep-pwcheck.py --batch vault|backup   (tests)
#        stdin: a JSON list of passwords → a JSON list of results
#
#  The password is read from stdin, never from the command line, so it
#  never shows in the process list. Word lists: $SAFEKEEP_PWCHECK_LISTS,
#  else /usr/local/share/safekeep/pwcheck-lists.json, else the file next
#  to this script.
# =====================================================================
import json
import math
import os
import sys

BANDS = {
    "vault": {"weak": 40, "strong": 60},
    "backup": {"weak": 50, "strong": 65},
}

LIST_ORDER = ["passwords", "english_wikipedia", "us_tv_and_film", "surnames", "female_names", "male_names", "bip39"]
LIST_KIND = {
    "passwords": "common", "english_wikipedia": "word", "us_tv_and_film": "word",
    "surnames": "name", "female_names": "name", "male_names": "name", "bip39": "word",
}
MIN_WORD = 3
MAX_WORD = 32
MAX_SPLIT = 128
PIECE_BITS = 1
YEAR_BITS = math.log2(150)
SEPARATORS = [" ", "-", "_", ".", ",", "+", "/"]
SEPARATOR_BITS = 3
BIP39_WORD_BITS = 11
L33T = {
    "4": ["a"], "@": ["a"], "8": ["b"], "(": ["c"], "3": ["e"], "6": ["g"], "9": ["g"],
    "1": ["i", "l"], "!": ["i"], "|": ["i", "l"], "0": ["o"], "$": ["s"], "5": ["s"],
    "7": ["t"], "+": ["t"], "2": ["z"],
}

REASON_TEXT = {
    "common": "a common password",
    "word": "common words",
    "name": "a name",
    "repeat": "repeated characters",
    "sequence": "a sequence such as abc or 123",
    "year": "a year",
}

LISTS_PATHS = [
    os.environ.get("SAFEKEEP_PWCHECK_LISTS", ""),
    "/usr/local/share/safekeep/pwcheck-lists.json",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "pwcheck-lists.json"),
]


class Dictionary:
    def __init__(self, lists):
        self.words = {}
        for name in LIST_ORDER:
            for i, w in enumerate(lists[name].split(",")):
                if not w:
                    continue
                rank = 2048 if name == "bip39" else i + 1
                cur = self.words.get(w)
                if cur is None or rank < cur[0]:
                    self.words[w] = (rank, LIST_KIND[name])
        self.bip39 = set(lists["bip39"].split(","))


def load_dictionary():
    for path in LISTS_PATHS:
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                return Dictionary(json.load(f)["lists"])
    raise FileNotFoundError("pwcheck-lists.json not found")


def char_bits(c):
    o = ord(c)
    if 48 <= o <= 57:
        return math.log2(10)
    if 97 <= o <= 122 or 65 <= o <= 90:
        return math.log2(26)
    if 32 <= o <= 126:
        return math.log2(33)
    return math.log2(100)


def is_upper(c):
    return "A" <= c <= "Z"


def is_lower(c):
    return "a" <= c <= "z"


def is_digit(c):
    return "0" <= c <= "9"


def lower(cps):
    return [c.lower() if is_upper(c) else c for c in cps]


def n_c_k(n, k):
    r = 1.0
    for i in range(1, k + 1):
        r = (r * (n - k + i)) / i
    return r


def case_variations(cps):
    up = sum(1 for c in cps if is_upper(c))
    low = sum(1 for c in cps if is_lower(c))
    if up == 0:
        return 1
    if low == 0:
        return 2
    if up == 1 and (is_upper(cps[0]) or is_upper(cps[-1])):
        return 2
    v = 0
    for i in range(1, min(up, low) + 1):
        v += n_c_k(up + low, i)
    return v


def readings(low_cps):
    out = [("".join(low_cps), 0)]
    if not any(is_lower(c) for c in low_cps):
        return out
    subs = sum(1 for c in low_cps if c in L33T)
    if subs == 0:
        return out
    for pick in (0, 1):
        w = "".join(L33T[c][min(pick, len(L33T[c]) - 1)] if c in L33T else c for c in low_cps)
        if not any(r[0] == w for r in out):
            out.append((w, subs))
    return out


def dictionary_bits(cps, d):
    if len(cps) < MIN_WORD or len(cps) > MAX_WORD:
        return None
    case_var = case_variations(cps)
    best = None
    for w, subs in readings(lower(cps)):
        rev = w[::-1]
        for word, rev_mul in ([(w, 1)] if rev == w else [(w, 1), (rev, 2)]):
            hit = d.words.get(word)
            if hit is None:
                continue
            bits = math.log2(hit[0] * case_var * 2 ** subs * rev_mul)
            if best is None or bits < best[0]:
                best = (bits, hit[1])
    return best


def repeat_bits(cps, d, cache):
    n = len(cps)
    if n < 2:
        return None
    for p in range(1, n // 2 + 1):
        if n % p:
            continue
        if all(cps[i] == cps[i - p] for i in range(p, n)):
            return (estimate_cps(cps[:p], d, cache)["bits"] + math.log2(n // p), "repeat")
    return None


def sequence_bits(cps):
    n = len(cps)
    if n < 3:
        return None
    first = cps[0]
    cls = is_digit if is_digit(first) else is_lower if is_lower(first) else is_upper if is_upper(first) else None
    if cls is None or not all(cls(c) for c in cps):
        return None
    step = ord(cps[1]) - ord(cps[0])
    if step not in (1, -1):
        return None
    for i in range(2, n):
        if ord(cps[i]) - ord(cps[i - 1]) != step:
            return None
    base = 4 if first in "aAzZ019" else 10 if is_digit(first) else 26
    return (math.log2(base * n * (2 if step < 0 else 1)), "sequence")


def year_bits(cps):
    if len(cps) != 4 or not all(is_digit(c) for c in cps):
        return None
    y = int("".join(cps))
    return (YEAR_BITS, "year") if 1900 <= y <= 2049 else None


def piece_bits(cps, d, cache):
    best = None
    for r in (dictionary_bits(cps, d), repeat_bits(cps, d, cache), sequence_bits(cps), year_bits(cps)):
        if r is not None and (best is None or r[0] < best[0]):
            best = r
    return best


def estimate_cps(cps, d, cache):
    key = "".join(cps)
    if key in cache:
        return cache[key]
    n = min(len(cps), MAX_SPLIT)
    best = [math.inf] * (n + 1)
    came_from = [None] * (n + 1)
    best[0] = 0
    for i in range(1, n + 1):
        best[i] = best[i - 1] + char_bits(cps[i - 1])
        came_from[i] = (i - 1, None)
        for j in range(0, i - 1):
            piece = piece_bits(cps[j:i], d, cache)
            if piece is None:
                continue
            total = best[j] + piece[0] + PIECE_BITS
            if total < best[i]:
                best[i] = total
                came_from[i] = (j, piece[1])
    bits = best[n]
    for i in range(n, len(cps)):
        bits += char_bits(cps[i])
    kinds = []
    i = n
    while i > 0:
        j, kind = came_from[i]
        if kind:
            kinds.insert(0, kind)
        i = j
    reasons = []
    for k in kinds:
        if k not in reasons:
            reasons.append(k)
    result = {"bits": bits, "reasons": reasons}
    cache[key] = result
    return result


def estimate_password(cps, d):
    cache = {}
    best = estimate_cps(cps, d, cache)
    for sep in SEPARATORS:
        if sep not in cps:
            continue
        parts = [[]]
        for c in cps:
            if c == sep:
                parts.append([])
            else:
                parts[-1].append(c)
        if any(len(p) == 0 for p in parts):
            continue
        if len(parts) >= 3 and all("".join(p) in d.bip39 for p in parts):
            return {"bits": len(parts) * BIP39_WORD_BITS + SEPARATOR_BITS, "reasons": ["few-words"]}
        bits = SEPARATOR_BITS
        reasons = []
        for p in parts:
            r = estimate_cps(p, d, cache)
            bits += r["bits"]
            for k in r["reasons"]:
                if k not in reasons:
                    reasons.append(k)
        if bits < best["bits"]:
            best = {"bits": bits, "reasons": reasons}
    return best


def rate_password(password, context, d):
    bands = BANDS[context]
    r = estimate_password(list(password), d)
    bits = r["bits"]
    band = "weak" if bits < bands["weak"] else "fair" if bits < bands["strong"] else "strong"
    return {"bits": bits, "band": band, "reasons": r["reasons"]}


def describe_rating(rating):
    if rating["band"] == "strong":
        return ""
    if ",".join(rating["reasons"]) == "few-words":
        return "Random words are good, but each adds only about 11 bits: use more of them."
    parts = [REASON_TEXT[r] for r in rating["reasons"]]
    if not parts:
        return "It is too short."
    lst = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
    return "It is mostly " + lst + ", which attackers try first."


def _result(password, context, d):
    r = rate_password(password, context, d)
    r["message"] = describe_rating(r)
    return r


def main(argv):
    mode = argv[1] if len(argv) == 3 and argv[1] in ("--batch", "--lines") else ""
    context = argv[2] if mode else (argv[1] if len(argv) == 2 else "")
    if context not in BANDS:
        sys.stderr.write("usage: safekeep-pwcheck.py [--batch|--lines] vault|backup  (password on stdin)\n")
        return 2
    d = load_dictionary()
    raw = sys.stdin.buffer.read()
    if mode == "--batch":
        sys.stdout.write(json.dumps([_result(p, context, d) for p in json.loads(raw.decode("utf-8"))]) + "\n")
        return 0
    out = _result(raw.decode("utf-8", errors="surrogateescape"), context, d)
    if mode == "--lines":
        sys.stdout.write("%s\n%d\n%s\n" % (out["band"], int(out["bits"]), out["message"]))
    else:
        sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
