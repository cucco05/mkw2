#!/usr/bin/env python3
# R1-3 / KLOSS hardening B - an INDEPENDENT recomputation of the golden cart fingerprints (tests/fixtures/cart-fingerprint-golden.json). It uses nothing of the repository's code: the canonical JSON
# (lib/cart-canonical-core.ts, canonicalJson), the grouping of the lines of a complete copy (canonicalCartItemsWith) and versions 1 and 2 of the checkout and cart fingerprints
# (lib/cart-fingerprint.ts) are written again here from their definition - keys sorted by UTF-16 code units, `undefined` left out (JSON has none), numbers written as JavaScript's
# Number.prototype.toString writes them, strings as JSON.stringify writes them, the text hashed as UTF-8 with SHA-256.
# usage: python3 scripts/cart-fingerprint-golden.py [fixture.json]      exit 0: every value recomputed and equal; 1: a difference (printed); 2: the fixture can not be read
import hashlib
import json
import math
import sys


def js_number(x) -> str:
    # ECMAScript Number::toString(x), radix 10: the shortest digits that read back as x (Python's repr gives the same digits), then the layout of the specification
    if isinstance(x, int):
        return str(x)
    if not math.isfinite(x):
        return 'null'  # (JSON.stringify of NaN or an infinity)
    if x == 0:
        return '0'
    sign = '-' if x < 0 else ''
    text = repr(abs(x)).lower()
    mantissa, exponent = (text.split('e') + ['0'])[:2]
    whole, _, fraction = mantissa.partition('.')
    raw = whole + fraction
    stripped = raw.lstrip('0')
    n = len(whole) - (len(raw) - len(stripped)) + int(exponent)
    digits = stripped.rstrip('0') or '0'
    k = len(digits)
    if k <= n <= 21:
        out = digits + '0' * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0:
        out = '0.' + '0' * (-n) + digits
    else:
        e = n - 1
        power = ('+' if e >= 0 else '-') + str(abs(e))
        out = (digits if k == 1 else digits[0] + '.' + digits[1:]) + 'e' + power
    return sign + out


def utf16(text: str) -> bytes:
    # the order of JavaScript's `<` on strings (UTF-16 code units)
    return text.encode('utf-16-be', 'surrogatepass')


def canonical(value) -> str:
    if isinstance(value, list):
        return '[' + ','.join(canonical(item) for item in value) + ']'
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=utf16)
        return '{' + ','.join(json.dumps(key, ensure_ascii=False) + ':' + canonical(value[key]) for key in keys) + '}'
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    raise TypeError(f'not a JSON value: {value!r}')


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def canonical_cart_items(items):
    cores = []
    for item in items:
        core = {key: val for key, val in item.items() if key != 'setKey'}
        set_key = item.get('setKey')
        cores.append((str(set_key) if set_key else None, core, canonical(core)))
    members = {}
    for key, _, text in cores:
        if key:
            members.setdefault(key, []).append(text)
    label = {key: sha256('\n'.join(sorted(texts, key=utf16)))[:16] for key, texts in members.items()}
    out = [({**core, 'group': label[key]} if key else core) for key, core, _ in cores]
    return sorted(out, key=lambda entry: utf16(canonical(entry)))


def fingerprints(case):
    principal = case['principalId'] if case['principalId'] is not None else 'guest'
    items = case['parsed']
    common = {'principal': principal, 'shipping': case['shippingMethod'], 'rush': case['rush']}
    total = {'expectedTotal': case['expectedTotalCents']}
    v1 = {'v': 1, **common, 'items': items}
    v2 = {'v': 2, **common, 'items': canonical_cart_items(items)}
    return {
        'v1': {'cart': sha256(canonical(v1)), 'checkout': sha256(canonical({**v1, **total}))},
        'v2': {'cart': sha256(canonical(v2)), 'checkout': sha256(canonical({**v2, **total}))},
    }


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else 'tests/fixtures/cart-fingerprint-golden.json'
    try:
        cases = json.load(open(path, encoding='utf-8'))['cases']
    except Exception as error:  # noqa: BLE001 - any failure to read is "can not tell"
        print(f'the fixture can not be read: {error}')
        return 2
    differences = 0
    for case in cases:
        got = fingerprints(case)
        for version in ('v1', 'v2'):
            for kind in ('cart', 'checkout'):
                if got[version][kind] != case[version][kind]:
                    differences += 1
                    print(f'DIFFERENT {case["name"]} {version}.{kind}: recomputed {got[version][kind]}, golden {case[version][kind]}')
    print(f'{len(cases)} cases, {len(cases) * 4} fingerprints recomputed independently: {"all equal" if differences == 0 else f"{differences} different"}')
    return 0 if differences == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
