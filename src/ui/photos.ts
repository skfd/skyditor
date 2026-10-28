// The photo panel beside the map (PEEK-003, PEEK-004, PEEK-005).
import type { Photo } from "../osm/photos";

export interface PhotoView {
  title: string; // what the photo is of, in the user's words
  state: "loading" | "photo" | "none" | "error";
  photo?: Photo;
  distance?: number; // m from the building
  links: { name: string; url: string }[];
  detail?: string; // for "error": what went wrong
}

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class PhotoPanel {
  private readonly root = document.querySelector("#photo") as HTMLElement;

  constructor(onClose: () => void) {
    this.root.querySelector(".close")!.addEventListener("click", onClose);
  }

  get open() {
    return !this.root.hidden;
  }

  show(v: PhotoView) {
    this.root.hidden = false;
    const body = this.root.querySelector(".body") as HTMLElement;
    this.root.querySelector("h4")!.textContent = v.title;
    const nodes: Node[] = [];
    if (v.state === "loading") nodes.push(el("p", "muted", "Looking for photos…"));
    else if (v.state === "photo" && v.photo) {
      const img = el("img") as HTMLImageElement;
      img.alt = "Street-level photo";
      img.src = v.photo.sd;
      img.loading = "eager";
      const a = el("a") as HTMLAnchorElement;
      a.href = v.photo.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.append(img);
      nodes.push(a);
      const when = v.photo.date ? new Date(v.photo.date).toLocaleDateString(undefined, { year: "numeric", month: "short" }) : "";
      nodes.push(el("p", "muted", [v.photo.provider, when, v.distance !== undefined ? `${Math.round(v.distance)} m away` : ""].filter(Boolean).join(" · ")));
    } else if (v.state === "none") nodes.push(el("p", "muted", "No open street photo near this building yet."));
    else nodes.push(el("p", "muted", `Couldn't look for photos: ${v.detail ?? "network error"}`));
    const links = el("p", "links");
    for (const l of v.links) {
      const a = el("a", undefined, `${l.name} ↗`) as HTMLAnchorElement;
      a.href = l.url;
      a.target = "_blank";
      a.rel = "noopener";
      links.append(a);
    }
    nodes.push(links);
    body.replaceChildren(...nodes);
  }

  hide() {
    this.root.hidden = true;
  }
}
