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
  ERASE: svg(`<path d="M15.5 5.5l7 7-10 10H8l-3.5-3.5z M8.6 13.4l7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M14 22.5h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>`),
  SOUND_ON: svg(`<path d="M5 11h4l6-5v16l-6-5H5z"/><path d="M18.5 9.5a6 6 0 0 1 0 9M21.5 6.5a10 10 0 0 1 0 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
  SOUND_OFF: svg(`<path d="M5 11h4l6-5v16l-6-5H5z"/><path d="M19 11l6 6M25 11l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
};
