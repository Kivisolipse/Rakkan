import { Notice, setIcon, setTooltip, type Setting } from "obsidian";

/**
 * Put a setting's explanation behind a small info icon next to its name: a
 * tooltip on hover, and a notice on tap for devices that have no hover.
 */
export function hint(setting: Setting, text: string): Setting {
  const icon = setting.nameEl.createSpan({ cls: "rk-hint", attr: { "aria-label": text } });
  setIcon(icon, "info");
  setTooltip(icon, text, { placement: "top" });
  icon.addEventListener("click", () => new Notice(text, 10000));
  return setting;
}
