// @vitest-environment node
/*
 * The dev mock stands in for the server (`API_MOCK=1`). Checked here is what would
 * otherwise break it without a word: the consent version it accepts, its answer to a
 * batch of events, and the PNG it writes out byte by byte.
 */
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MOCK_CONSENT_VERSION } from '../mock/fixtures.ts';
import { eventsAnswer } from '../mock/plugin.ts';
import { renderMockWheelPng } from '../mock/wheelPng.ts';
import { CONSENT_VERSION } from '../src/i18n/ru.ts';

describe('mock API', () => {
  it('accepts the version of the app\'s own texts: after a new CONSENT_VERSION the mock needs the same date', () => {
    expect(MOCK_CONSENT_VERSION).toBe(CONSENT_VERSION);
  });

  it('answers a batch of events the way the contract says: takes, refuses whole, or drops in silence', () => {
    const NOW = Date.parse('2026-11-10T12:00:00.000Z');
    const at = new Date(NOW).toISOString();
    const answer = (events: unknown) => eventsAnswer({ events }, NOW);

    expect(answer([{ name: 'app_open', at }, { name: 'screen_view', at, props: { step: 'welcome' } }])).toEqual({ accepted: 2 });
    // One event the contract does not have: the whole batch is refused.
    expect(answer([{ name: 'app_open', at }, { name: 'app_closed', at }])).toEqual({
      errors: [{ field: 'events.name', message: expect.any(String) as string }],
    });
    expect(answer([])).toHaveProperty('errors');
    // Props named like personal data: the event is dropped, the batch is not an error.
    expect(answer([{ name: 'app_open', at }, { name: 'place_search', at, props: { query: 'x' } }])).toEqual({ accepted: 1 });
  });

  it('writes a PNG a viewer can open: signature, intact chunks, as many pixels as the header says', () => {
    const png = renderMockWheelPng('dark', 200);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const chunks: { type: string; data: Buffer; intact: boolean }[] = [];
    for (let offset = 8; offset < png.length; ) {
      const length = png.readUInt32BE(offset);
      const body = png.subarray(offset + 4, offset + 8 + length);
      chunks.push({ type: body.subarray(0, 4).toString('ascii'), data: body.subarray(4), intact: png.readUInt32BE(offset + 8 + length) === crc32(body) });
      offset += 12 + length;
    }
    expect(chunks.map(({ type }) => type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    expect(chunks.every(({ intact }) => intact)).toBe(true);

    const [header, , data] = chunks;
    expect([header?.data.readUInt32BE(0), header?.data.readUInt32BE(4)]).toEqual([200, 200]);
    // A filter byte and 200 palette indexes per row; more than one colour, so not a blank square.
    const pixels = inflateSync(data?.data ?? Buffer.alloc(0));
    expect(pixels.length).toBe(201 * 200);
    expect(new Set(pixels).size).toBeGreaterThan(2);
  });
});
