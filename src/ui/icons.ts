// Palette icons (HUD-001). The residential ladder's silhouettes grow taller from R1 to R6 (KIND-002).
const svg = (body: string) =>
  `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" fill="currentColor" fill-rule="evenodd">${body}</svg>`;

const ground = `<rect x="2" y="24" width="24" height="1.6" rx="0.8" opacity="0.45"/>`;

export const ICONS: Record<string, string> = {
  R1: svg(`${ground}<path d="M5 24v-5l4-3.5 4 3.5v5z"/><circle cx="20" cy="17.5" r="3.6"/><rect x="19.3" y="20" width="1.4" height="4"/>`),
  R2: svg(`${ground}<path d="M7 24v-8l7-6 7 6v8h-5v-4h-4v4z"/>`),
  R3: svg(`${ground}<path d="M3.5 24v-8l5.5-5 5 4.5 5-4.5 5.5 5v8z M7.5 18h3v3h-3z M17.5 18h3v3h-3z"/>`),
  R4: svg(`${ground}<path d="M3 24v-9l3-3 3 3 3-3 3 3 3-3 3 3 3-3 1 1v11z M4.8 17.5h2.4v2.4H4.8z M10.8 17.5h2.4v2.4h-2.4z M16.8 17.5h2.4v2.4h-2.4z"/>`),
  R5: svg(`${ground}<path d="M6 24V8h16v16z M8.5 10.5h3v2.5h-3z M12.5 10.5h3v2.5h-3z M16.5 10.5h3v2.5h-3z M8.5 15h3v2.5h-3z M12.5 15h3v2.5h-3z M16.5 15h3v2.5h-3z M8.5 19.5h3v2.5h-3z M16.5 19.5h3v2.5h-3z"/>`),
  R6: svg(`${ground}<path d="M9 24V2.5h9V24z M11 5h2v2h-2z M14.5 5h2v2h-2z M11 9h2v2h-2z M14.5 9h2v2h-2z M11 13h2v2h-2z M14.5 13h2v2h-2z M11 17h2v2h-2z M14.5 17h2v2h-2z"/><path d="M19.5 24V11h4.5v13z" opacity="0.7"/><path d="M4 24V14h4v10z" opacity="0.7"/>`),
  COM: svg(`${ground}<path d="M7 24V6l7-2.5L21 6v18z M9 9h10v1.6H9z M9 13h10v1.6H9z M9 17h10v1.6H9z"/>`),
  RET: svg(`${ground}<path d="M5 24V14h18v10h-5v-6h-4v6z"/><path d="M4 9h20l-1 4.5c-.9 1.2-2.4 1.2-3.3 0-.9 1.2-2.4 1.2-3.3 0-.9 1.2-2.4 1.2-3.3 0-.9 1.2-2.4 1.2-3.3 0-.9 1.2-2.4 1.2-3.3 0z"/>`),
  IND: svg(`${ground}<path d="M3 24V14l5 3v-3l5 3v-3l5 3V6h3v18z M6 19h2.5v2H6z M11 19h2.5v2H11z"/><circle cx="20" cy="3.6" r="1.6" opacity="0.5"/>`),
  UP: svg(`<path d="M14 4l8 8h-5v4h-6v-4H6z"/><rect x="6" y="19" width="16" height="2.4" rx="1.2" opacity="0.6"/><rect x="6" y="23" width="16" height="2.4" rx="1.2" opacity="0.35"/>`),
  DOWN: svg(`<rect x="6" y="3" width="16" height="2.4" rx="1.2" opacity="0.35"/><rect x="6" y="7" width="16" height="2.4" rx="1.2" opacity="0.6"/><path d="M14 25l-8-8h5v-4h6v4h5z"/>`),
  // TYPE-007: a tick over a house — "yes, that's what it is".
  AGREE: svg(`${ground}<path d="M4 24v-8l6-5 6 5v8h-4v-4h-4v4z" opacity="0.55"/><path d="M14 13l4 4 7-8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`),
  ERASE: svg(`<path d="M15.5 5.5l7 7-10 10H8l-3.5-3.5z M8.6 13.4l7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M14 22.5h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>`),
  // Map controls (HUD-006) and layer toggles (HUD-007).
  UNDO: svg(`<path d="M10 6l-5 5 5 5M5.5 11h11a6 6 0 0 1 0 12H12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`),
  REDO: svg(`<path d="M18 6l5 5-5 5M22.5 11h-11a6 6 0 0 0 0 12H16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`),
  ZOOM_IN: svg(`<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M17.5 17.5L24 24M8.5 12h7M12 8.5v7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`),
  ZOOM_OUT: svg(`<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M17.5 17.5L24 24M8.5 12h7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`),
  FIT: svg(`<path d="M4 10V4h6M18 4h6v6M24 18v6h-6M10 24H4v-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="10" y="10" width="8" height="8" rx="1.5" opacity="0.5"/>`),
  PLUS: svg(`<path d="M14 7v14M7 14h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`),
  MINUS: svg(`<path d="M7 14h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`),
  BUILDINGS: svg(`${ground}<path d="M4 24V12h9v12z M15 24V5h9v19z M17.5 8h4v2h-4z M17.5 12h4v2h-4z M17.5 16h4v2h-4z M6.5 15h4v2h-4z"/>`),
  // TYPE-006: the brush target — a brush ring over a house.
  TARGET: svg(`<path d="M5 24v-9l7-6 7 6v9h-5v-5h-4v5z"/><circle cx="19" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="3 2.4"/>`),
  // TYPE-012: a question mark in a round mark, the unsure building's badge.
  UNSURE: svg(`<circle cx="14" cy="14" r="11"/><path d="M10.5 11a3.5 3.5 0 1 1 5 3.2c-1 .6-1.5 1.2-1.5 2.3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="14" cy="20" r="1.5" fill="#fff"/>`),
  OUTLINES: svg(`<path d="M5 9l9-5 9 6v12l-9 3-9-4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="3.2 2.6" stroke-linejoin="round"/>`),
  // HUD-009: the red spikes of a disputed piece (REN-013), round a small block.
  DISPUTE: svg(`<path d="M14 2.5l2.6 4.9 5.5-1.3-1.3 5.5 4.9 2.6-4.9 2.6 1.3 5.5-5.5-1.3L14 25.5l-2.6-4.9-5.5 1.3 1.3-5.5L2.3 14l4.9-2.6-1.3-5.5 5.5 1.3z"/><rect x="10" y="10" width="8" height="8" rx="1.5" fill="#fff"/>`),
  SOUND_ON: svg(`<path d="M5 11h4l6-5v16l-6-5H5z"/><path d="M18.5 9.5a6 6 0 0 1 0 9M21.5 6.5a10 10 0 0 1 0 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
  SOUND_OFF: svg(`<path d="M5 11h4l6-5v16l-6-5H5z"/><path d="M19 11l6 6M25 11l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
};
