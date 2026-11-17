// The look of a lovewall event: one template themes both the guest page and the wall.
// Colours, type and shapes live in src/styles/lovewall.css under [data-theme]; this file is the part the code needs.

export type TemplateId = 'classic' | 'corporate' | 'hitech' | 'elegant' | 'garden' | 'festive';

export interface Look {
  template?: string;
  title?: string;
  subtitle?: string;
  accent?: string;
  logo_path?: string | null;
}

export const TEMPLATES: { id: TemplateId; name: string; for: string; accent: string; fonts: string }[] = [
  { id: 'classic', name: 'Classic', for: 'Any event', accent: '#e8456b', fonts: '' },
  { id: 'corporate', name: 'Keynote', for: 'Conferences, launches, company events', accent: '#1d4ed8', fonts: 'family=Schibsted+Grotesk:wght@500;700;800' },
  { id: 'hitech', name: 'Hi-tech', for: 'Product launches, tech and gaming events', accent: '#22d3ee', fonts: 'family=Chakra+Petch:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600' },
  { id: 'elegant', name: 'Black tie', for: 'Weddings, galas, anniversaries', accent: '#c9a96a', fonts: 'family=Bodoni+Moda:ital,wght@0,500;1,500&family=Jost:wght@400;500' },
  { id: 'garden', name: 'Garden', for: 'Weddings, showers, spring and outdoor parties', accent: '#2f7d4f', fonts: 'family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,700;1,9..144,500&family=Nunito+Sans:wght@400;600;700' },
  { id: 'festive', name: 'Confetti', for: 'Birthdays and parties', accent: '#ff5a3c', fonts: 'family=Bricolage+Grotesque:wght@600;800&family=Figtree:wght@500;600' },
];

// accents a non-designer can pick in one tap; the native colour input covers the rest
export const SWATCHES = ['#22d3ee', '#1d4ed8', '#0f766e', '#c9a96a', '#e8456b', '#ff5a3c', '#7c3aed'];

export const template = (id?: string) => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];

const HEX = /^#[0-9a-f]{6}$/i;

// white or near-black text, whichever reads better on the accent (WCAG relative luminance)
function onColour(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

// inline custom properties: only the organiser's accent overrides the template's own
export function accentStyle(accent?: string) {
  return accent && HEX.test(accent) ? `--accent:${accent};--on-accent:${onColour(accent)};` : '';
}

// Fonts come from Google Fonts, added once per page. Offline they fall back to the stacks in lovewall.css.
export function loadFonts(id?: string) {
  const f = template(id).fonts;
  if (!f || typeof document === 'undefined' || document.getElementById('lw-fonts-' + id)) return;
  const link = document.createElement('link');
  link.id = 'lw-fonts-' + id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${f}&display=swap`;
  document.head.append(link);
}
