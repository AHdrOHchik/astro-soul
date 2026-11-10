/* A stand-in picture for GET /charts/{id}/wheel.svg. Not a real chart: the real one is drawn by packages/astro. */

const GLYPHS = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];
const BODIES = [
  { glyph: '☉', angle: 56, color: '#f1c76a' },
  { glyph: '☽', angle: 183, color: '#f4f1ff' },
  { glyph: '☿', angle: 71, color: '#b9a1ff' },
  { glyph: '♀', angle: 19, color: '#b9a1ff' },
  { glyph: '♂', angle: 247, color: '#b9a1ff' },
];

const point = (angle: number, radius: number) => {
  const radians = ((angle - 90) * Math.PI) / 180;
  return { x: (200 + radius * Math.cos(radians)).toFixed(1), y: (200 + radius * Math.sin(radians)).toFixed(1) };
};

export function renderMockWheel(theme: 'dark' | 'light'): string {
  const ink = theme === 'dark' ? '#f4f1ff' : '#1a1730';
  const line = theme === 'dark' ? '#6f67a0' : '#aca6cb';
  const paper = theme === 'dark' ? '#1a1730' : '#ffffff';

  const sectors = GLYPHS.map((glyph, index) => {
    const from = point(index * 30, 150);
    const to = point(index * 30, 190);
    const label = point(index * 30 + 15, 170);
    return (
      `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${line}"/>` +
      `<text x="${label.x}" y="${label.y}" fill="${ink}" font-size="18" text-anchor="middle" dominant-baseline="central">${glyph}&#xFE0E;</text>`
    );
  }).join('');

  const bodies = BODIES.map(({ glyph, angle, color }) => {
    const mark = point(angle, 150);
    const label = point(angle, 124);
    return (
      `<circle cx="${mark.x}" cy="${mark.y}" r="3" fill="${color}"/>` +
      `<text x="${label.x}" y="${label.y}" fill="${color}" font-size="20" text-anchor="middle" dominant-baseline="central">${glyph}</text>`
    );
  }).join('');

  const sun = point(56, 150);
  const moon = point(183, 150);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="Mock chart wheel">` +
    `<circle cx="200" cy="200" r="190" fill="${paper}" stroke="${line}"/>` +
    `<circle cx="200" cy="200" r="150" fill="none" stroke="${line}"/>` +
    `<circle cx="200" cy="200" r="70" fill="none" stroke="${line}" stroke-dasharray="2 5"/>` +
    sectors +
    `<line x1="${sun.x}" y1="${sun.y}" x2="${moon.x}" y2="${moon.y}" stroke="#b9a1ff" stroke-opacity="0.6"/>` +
    bodies +
    `<text x="200" y="200" fill="${line}" font-size="13" font-family="sans-serif" text-anchor="middle" dominant-baseline="central">MOCK</text>` +
    `</svg>`
  );
}
