// Pip's SVG. Silhouette, headphones and star are identical in every mood;
// only the face, arms and small extras change (same rule as the emotion sheet).
const INK = '#111';
const line = (w = 4.5) => `fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;

const star = (cx, cy, ro, ri) =>
  Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

const sparkle = (x, y, s) =>
  `<path d="M${x} ${y - s}Q${x} ${y} ${x + s} ${y}Q${x} ${y} ${x} ${y + s}Q${x} ${y} ${x - s} ${y}Q${x} ${y} ${x} ${y - s}Z" fill="${INK}"/>`;

const arm = (d) =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="16" stroke-linecap="round"/>` +
  `<path d="${d}" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/>`;

const puff = (x, y) =>
  [[-7, 2], [7, 2], [0, -6]].map(([dx, dy]) => `<circle cx="${x + dx}" cy="${y + dy}" r="6" fill="#fff" stroke="${INK}" stroke-width="3"/>`).join('') +
  [[-7, 2], [7, 2], [0, -6]].map(([dx, dy]) => `<circle cx="${x + dx}" cy="${y + dy}" r="5" fill="#fff"/>`).join('');

const tear = (x, y) => `<path d="M${x} ${y}Q${x - 5} ${y + 8} ${x} ${y + 12}Q${x + 5} ${y + 8} ${x} ${y}Z" fill="#fff" stroke="${INK}" stroke-width="2.5"/>`;

const FACES = {
  happy: {
    face:
      `<path d="M85 119Q95 106 105 119M135 119Q145 106 155 119" ${line()}/>` +
      `<path d="M106 134Q120 156 134 134Z" fill="${INK}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
      `<path d="M76 131l-3 6M83 131l-3 6M157 131l3 6M164 131l3 6" ${line(2.5)}/>`,
    arms: arm('M62 160Q34 160 28 130') + arm('M178 160Q206 160 212 130'),
    extras: sparkle(26, 64, 10) + sparkle(214, 76, 8) + sparkle(24, 182, 6) + sparkle(216, 168, 7),
  },
  sad: {
    face:
      `<circle cx="95" cy="123" r="5.5" fill="${INK}"/><circle cx="145" cy="123" r="5.5" fill="${INK}"/>` +
      `<path d="M84 111L104 105M156 111L136 105" ${line(3.5)}/>` +
      `<path d="M108 147Q120 137 132 147" ${line()}/>` + tear(91, 131) + tear(149, 131),
    arms: arm('M62 160Q50 176 54 192') + arm('M178 160Q190 176 186 192'),
    extras:
      `<path d="M98 29a10 10 0 0 1 2-19a15 15 0 0 1 27-3a11 11 0 0 1 11 22Z" fill="#fff" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<path d="M108 35v6M120 37v6M132 35v6" ${line(3)}/>`,
  },
  angry: {
    face:
      `<path d="M82 106L106 118M158 106L134 118" ${line(5)}/>` +
      `<ellipse cx="96" cy="127" rx="6" ry="4.5" fill="${INK}"/><ellipse cx="144" cy="127" rx="6" ry="4.5" fill="${INK}"/>` +
      `<path d="M108 145Q114 138 120 145Q126 138 132 145" ${line(3.5)}/>`,
    arms: arm('M64 158Q100 178 152 160') + arm('M176 158Q140 180 90 162'),
    extras: puff(34, 62) + puff(206, 62),
  },
  surprised: {
    face:
      `<path d="M84 100Q95 92 106 100M134 100Q145 92 156 100" ${line(3.5)}/>` +
      `<circle cx="95" cy="121" r="10" fill="#fff" stroke="${INK}" stroke-width="4"/><circle cx="145" cy="121" r="10" fill="#fff" stroke="${INK}" stroke-width="4"/>` +
      `<circle cx="96" cy="122" r="4" fill="${INK}"/><circle cx="144" cy="122" r="4" fill="${INK}"/>` +
      `<ellipse cx="120" cy="144" rx="6" ry="8.5" fill="${INK}"/>`,
    arms: arm('M62 158Q32 158 24 126') + arm('M178 158Q208 158 216 126'),
    extras:
      `<path d="M198 16v17M216 24v12" ${line(7)}/><circle cx="198" cy="44" r="4.5" fill="${INK}"/><circle cx="216" cy="46" r="4" fill="${INK}"/>`,
  },
};

const BODY =
  'M60 112C60 66 88 44 120 44C152 44 180 66 180 112L180 168C180 180 170 186 162 178C154 170 146 184 136 188C126 192 118 180 108 186C98 192 90 182 82 186C72 190 60 182 60 168Z';

export function pipSvg(mood) {
  const f = FACES[mood] || FACES.happy;
  return (
    `<svg viewBox="0 0 240 230" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    `<ellipse class="pip-shadow" cx="120" cy="214" rx="42" ry="6" fill="#000" opacity=".14"/>` +
    `<g class="pip-float">` +
    `<path d="${BODY}" fill="#fff" stroke="${INK}" stroke-width="4.5" stroke-linejoin="round"/>` +
    f.arms +
    `<path d="M54 108C50 22 190 22 186 108" ${line(7)}/>` +
    `<ellipse cx="52" cy="108" rx="13" ry="21" fill="${INK}"/><ellipse cx="188" cy="108" rx="13" ry="21" fill="${INK}"/>` +
    `<polygon points="${star(52, 108, 9, 3.8)}" fill="#fff"/>` +
    f.face +
    f.extras +
    `</g></svg>`
  );
}
