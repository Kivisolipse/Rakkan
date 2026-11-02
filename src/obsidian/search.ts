import { App, Modal, Setting } from "obsidian";
import { looseRegexSource } from "../core";
import { t } from "../i18n";
import { hint } from "./hint";

interface GlobalSearch {
  openGlobalSearch(query: string): void;
}

/** Open Obsidian's own search pane; fall back to the documented URI. */
export function openSearch(app: App, query: string) {
  const internal = (app as unknown as {
    internalPlugins?: { getPluginById?(id: string): { instance?: Partial<GlobalSearch> } | null };
  }).internalPlugins;
  const search = internal?.getPluginById?.("global-search")?.instance;
  if (search?.openGlobalSearch) {
    search.openGlobalSearch(query);
    return;
  }
  window.open(
    `obsidian://search?vault=${encodeURIComponent(app.vault.getName())}&query=${encodeURIComponent(query)}`,
  );
}

export function searchQuery(text: string, ignoreFormat: boolean): string {
  return ignoreFormat ? `/${looseRegexSource(text)}/` : text;
}

export class LooseSearchModal extends Modal {
  private value: string;
  private ignore: boolean;

  constructor(
    app: App,
    initial: string,
    ignoreFormat: boolean,
  ) {
    super(app);
    this.value = initial;
    this.ignore = ignoreFormat;
  }

  override onOpen() {
    this.setTitle(t("搜索（忽略格式）"));
    const submit = () => {
      if (!this.value.trim()) return;
      this.close();
      openSearch(this.app, searchQuery(this.value, this.ignore));
    };
    new Setting(this.contentEl).setName(t("搜索")).addText((t) => {
      t.setValue(this.value).onChange((v) => (this.value = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          submit();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(this.contentEl)
      .setName(t("忽略格式"))
      .then((row) => hint(row, t("忽略字符之间的 && @@ ** == ~~ ` [[ ]]，例如被标记隔开的「分页@@机制@@」也能搜到。")))
      .addToggle((t) => t.setValue(this.ignore).onChange((v) => (this.ignore = v)));
    new Setting(this.contentEl).addButton((b) => b.setButtonText(t("搜索")).setCta().onClick(submit));
  }

  override onClose() {
    this.contentEl.empty();
  }
}
