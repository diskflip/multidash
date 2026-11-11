import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pastelSymbolColorRgb } from '../src/lib/symbolColor.ts';

test('pastel blends most of the way to white while keeping the hue distinguishable', () => {
  // BTC orange (#f7931a = 247, 147, 26) at the default 72% white mix.
  const btc = pastelSymbolColorRgb('BTC').split(', ').map(Number);
  assert.deepEqual(btc, [
    Math.round(247 * 0.28 + 255 * 0.72),
    Math.round(147 * 0.28 + 255 * 0.72),
    Math.round(26 * 0.28 + 255 * 0.72),
  ]);
  // Lighter than the original on every channel, but not plain white —
  // the whole point is a tinted line, distinguishable market to market.
  assert.deepEqual(btc, [253, 225, 191]);
  assert.ok(btc.every((c, i) => c > [247, 147, 26][i] && c <= 255));

  // A symbol outside SYMBOL_COLOR falls back the same way the main price
  // line does, rather than throwing or returning garbage.
  assert.equal(pastelSymbolColorRgb('NOT_A_SYMBOL'), pastelSymbolColorRgb('NOT_A_SYMBOL'));

  // Two symbols' pastels stay distinguishable from each other, not
  // converging to the same near-white.
  assert.notEqual(pastelSymbolColorRgb('BTC'), pastelSymbolColorRgb('ETH'));

  // A full white-mix degenerates to pure white; 0 returns the raw color.
  assert.equal(pastelSymbolColorRgb('BTC', 1), '255, 255, 255');
  assert.equal(pastelSymbolColorRgb('BTC', 0), '247, 147, 26');
});
