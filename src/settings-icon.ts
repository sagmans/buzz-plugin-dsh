// Buzz draws an external plugin's Settings icon as a generic grid: PluginIcon
// (buzz-app src/app/Settings.tsx) looks up artwork for bundled plugins only, and
// Plugin API v1 has no icon contribution. So the plugin adds its artwork to the
// slot the app left generic, and lets the app's own tile styles draw it.
//
// React owns that slot, so no node it made is removed: the glyph is only hidden,
// and the image sits beside it. If the app ever draws the artwork itself, or its
// page changes, nothing matches and the app's own icon stays.
import ICON_URL from "../plugin/icon.png?inline";

const PLUGIN_ID = "sagmans.dsh";
/** The row's description: an id lookup, because this runs on each page change
 * in the whole app, and a selector over the page would cost more each time. */
const ROW_ANCHOR_ID = `plugin-description-${PLUGIN_ID}`;
const ROW = "[data-plugin-id]";
const EXPANDED = "aria-expanded";
const DETAILS_ID = "plugin-details";
/** The app's SquaresFourIcon, which it shows when it has no artwork. */
const GENERIC_GLYPH = "svg.tabler-icon-layout-grid";
/** The attribute that turns on the app's tile for a slot. */
const BRANDED = "data-branded";
/** Marks an image as this plugin's, so removal leaves other plugins' alone. */
const ICON_MARK = "data-external-plugin-icon";
const OWN_ICON = `img[${ICON_MARK}="${PLUGIN_ID}"]`;

function removeIcon(image: Element) {
  const slot = image.parentElement;
  slot
    ?.querySelector<SVGElement>(GENERIC_GLYPH)
    ?.style.removeProperty("display");
  slot?.removeAttribute(BRANDED);
  image.remove();
}

function addIcon(glyph: SVGElement | null | undefined) {
  const slot = glyph?.parentElement;
  if (!glyph || !slot || slot.querySelector(OWN_ICON)) return;
  const image = document.createElement("img");
  image.setAttribute(ICON_MARK, PLUGIN_ID);
  image.alt = "";
  image.src = ICON_URL;
  image.addEventListener("error", () => {
    console.error(`${PLUGIN_ID}: the Settings icon did not load`);
    removeIcon(image);
  });
  glyph.style.display = "none";
  slot.setAttribute(BRANDED, "");
  slot.append(image);
}

function paint() {
  const row = document.getElementById(ROW_ANCHOR_ID)?.closest(ROW);
  if (!row) return;
  addIcon(row.querySelector<SVGElement>(GENERIC_GLYPH));
  if (row.getAttribute(EXPANDED) === "true")
    addIcon(
      document
        .getElementById(DETAILS_ID)
        ?.querySelector<SVGElement>(GENERIC_GLYPH),
    );
}

/** Keeps the icon on the plugin's Settings row and details panel, which the app
 * mounts and unmounts as pages open. Returns what removes it again. */
export function showSettingsIcon(): () => void {
  const observer = new MutationObserver(paint);
  observer.observe(document.body, { childList: true, subtree: true });
  paint();
  return () => {
    observer.disconnect();
    for (const image of document.querySelectorAll(OWN_ICON)) removeIcon(image);
  };
}
