import { DEFAULT_PDF, type PdfOptions } from "./pdf";
import { App, PluginSettingTab, Setting } from "obsidian";
import { BUILTIN_FAMILIES, type ExtraPrefix } from "../core";
import { STYLES, type StyleName, type StyleSettings } from "../cm6/resolve";
import type RakkanPlugin from "../main";
import { DEFAULT_COLORS, type ColorPair } from "../cm6/colors";
import { setLanguage, t, type Language } from "../i18n";
import { hint } from "./hint";
import { hasOmnisearch } from "./omnisearch";


export interface RakkanSettings extends Omit<StyleSettings, "authors"> {
  /** Path of the author book note. */
  bookPath: string;
  /** Interface language; "auto" follows Obsidian. */
  language: Language;
  /** Hide markers away from the cursor in live preview. */
  hideMarkers: boolean;
  mode: "writing" | "review";
  stripOnCopy: boolean;
  /** Wrap what you type inside AI regions in `@@…@@`. */
  autoAnnotate: boolean;
  /** The "ignore formatting" toggle in Obsidian's search boxes. */
  searchIgnoreFormat: boolean;
  /** native: toggles in Obsidian's search boxes; window: Rakkan's own search window. */
  searchMode: "native" | "window";
  /** Patch Omnisearch so it finds words split by markers. */
  omnisearchCompat: boolean;
  showStatusBar: boolean;
  /** Signature used when "mark as AI" creates a block. */
  defaultSignature: string;
  /** Per family id, plus "generic" and "quote". Missing entries use the defaults. */
  colors: Record<string, ColorPair>;
  /** How strong colours are in writing mode (0–1). */
  writingStrength: number;
  /** Opacity of quoted sources (0–1). */
  sourceOpacity: number;
  /** The last options of "导出为 PDF". */
  pdf: PdfOptions;
}

export const DEFAULT_SETTINGS: RakkanSettings = {
  familyColors: true,
  aiStyle: "color",
  quoteStyle: "color",
  familyStyle: {},
  modelStyle: {},
  forceStyle: "",
  extraPrefixes: [],
  hideMarkers: true,
  mode: "review",
  stripOnCopy: true,
  autoAnnotate: true,
  searchIgnoreFormat: true,
  searchMode: "native",
  omnisearchCompat: true,
  showStatusBar: true,
  defaultSignature: "AI",
  colors: {},
  writingStrength: 0.35,
  sourceOpacity: 0.72,
  pdf: DEFAULT_PDF,
  bookPath: "AUTHORS.md",
  language: "auto",
};

const styleLabels = (): Record<StyleName, string> => ({
  color: t("彩色字"),
  gradient: t("渐变字"),
  rainbow: t("彩虹字"),
  underline: t("下划线"),
  none: t("关闭"),
});

function parseLines(text: string): Array<[string, string]> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=");
      return i < 0 ? ([l, ""] as [string, string]) : ([l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]);
    });
}

export class RakkanSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: RakkanPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
    };
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("语言"))
      .then((row) => hint(row, t("命令名称需重新加载插件后生效。")))
      .addDropdown((d) =>
        d
          .addOptions({ auto: t("跟随 Obsidian"), zh: "中文", en: "English" })
          .setValue(s.language)
          .onChange(async (v) => {
            s.language = v as Language;
            setLanguage(s.language);
            await save();
            this.display();
          }),
      );

    new Setting(containerEl).setName(t("显示")).setHeading();

    new Setting(containerEl)
      .setName(t("显示模式"))
      .then((row) => hint(row, t("写作：标记与颜色淡化；审阅：完整颜色。可为命令「切换写作 / 审阅显示」设置快捷键。")))
      .addDropdown((d) =>
        d
          .addOptions({ review: t("审阅"), writing: t("写作") })
          .setValue(s.mode)
          .onChange(async (v) => {
            s.mode = v as RakkanSettings["mode"];
            await save();
          }),
      );

    new Setting(containerEl)
      .setName(t("实时预览隐藏标记"))
      .then((row) => hint(row, t("光标不在该段时，隐藏 && @@ 与 [@key]，并隐藏块的开合行。")))
      .addToggle((t) =>
        t.setValue(s.hideMarkers).onChange(async (v) => {
          s.hideMarkers = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName(t("状态栏"))
      .then((row) => hint(row, t("显示原创、AI、引用的比例及提醒。")))
      .addToggle((t) =>
        t.setValue(s.showStatusBar).onChange(async (v) => {
          s.showStatusBar = v;
          await save();
        }),
      );

    new Setting(containerEl).setName(t("样式")).setHeading();

    const styleOptions = Object.fromEntries(STYLES.map((k) => [k, styleLabels()[k]]));

    new Setting(containerEl)
      .setName(t("按模型家族上色"))
      .then((row) => hint(row, t("关闭后，所有 AI 使用同一颜色。")))
      .addToggle((t) =>
        t.setValue(s.familyColors).onChange(async (v) => {
          s.familyColors = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName(t("AI 文字样式"))
      .addDropdown((d) =>
        d
          .addOptions(styleOptions)
          .setValue(s.aiStyle)
          .onChange(async (v) => {
            s.aiStyle = v as StyleName;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName(t("引用样式"))
      .addDropdown((d) =>
        d
          .addOptions(styleOptions)
          .setValue(s.quoteStyle)
          .onChange(async (v) => {
            s.quoteStyle = v as StyleName;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName(t("统一样式"))
      .then((row) => hint(row, t("优先于下方所有按家族、按模型的设置。")))
      .addDropdown((d) =>
        d
          .addOptions({ "": t("不使用"), ...styleOptions })
          .setValue(s.forceStyle)
          .onChange(async (v) => {
            s.forceStyle = v as StyleName | "";
            await save();
          }),
      );

    new Setting(containerEl).setName(t("模型家族")).setHeading();

    const families = [
      ...BUILTIN_FAMILIES,
      ...s.extraPrefixes.map((e) => ({ id: e.family, label: e.label ?? e.family })),
      { id: "generic", label: t("其他 AI") },
      { id: "quote", label: t("引用") },
    ].filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i);

    for (const f of families) {
      const d = DEFAULT_COLORS[f.id] ?? DEFAULT_COLORS.generic;
      const cur = () => s.colors[f.id] ?? { light: d.light, dark: d.dark };
      const row = new Setting(containerEl).setName(f.label);
      row.addColorPicker((c) => {
        c.setValue(cur().light).onChange(async (v) => {
          s.colors[f.id] = { ...cur(), light: v };
          await save();
        });
      });
      row.addColorPicker((c) => {
        c.setValue(cur().dark).onChange(async (v) => {
          s.colors[f.id] = { ...cur(), dark: v };
          await save();
        });
      });
      if (f.id !== "quote" && f.id !== "generic") {
        row.addDropdown((dd) =>
          dd
            .addOptions({ "": t("跟随默认"), ...styleOptions })
            .setValue(s.familyStyle[f.id] ?? "")
            .onChange(async (v) => {
              if (v) s.familyStyle[f.id] = v as StyleName;
              else delete s.familyStyle[f.id];
              await save();
            }),
        );
      }
      row.addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip(t("恢复默认颜色"))
          .onClick(async () => {
            delete s.colors[f.id];
            await save();
            this.display();
          }),
      );
      row.descEl.setText(t("左：浅色主题颜色；右：深色主题颜色") + (f.id !== "quote" && f.id !== "generic" ? t("；最右：该家族的样式") : ""));
    }

    new Setting(containerEl).setName(t("作者")).setHeading();

    const count = Object.keys(this.plugin.authors).length;
    new Setting(containerEl)
      .setName(t("{n} 位作者", { n: count }))
      .addButton((btn) =>
        btn.setButtonText(t("管理")).setCta().onClick(() => this.plugin.openAuthors()),
      )
      .addButton((btn) => btn.setButtonText(t("打开署名簿")).onClick(() => void this.plugin.openBookNote()));

    new Setting(containerEl).setName(t("颜色浓淡")).setHeading();

    new Setting(containerEl)
      .setName(t("写作模式颜色浓度"))
      .then((row) => hint(row, t("0 为不着色，1 与审阅模式相同。")))
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.05)
          .setValue(s.writingStrength)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.writingStrength = v;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName(t("来源透明度"))
      .then((row) => hint(row, t("无作者出处（书、网页）的显示浓淡，1 为不调暗。")))
      .addSlider((sl) =>
        sl
          .setLimits(0.2, 1, 0.05)
          .setValue(s.sourceOpacity)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.sourceOpacity = v;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName(t("按模型指定样式"))
      .then((row) => hint(row, t("每行一项：模型 ID 或 @key = 样式（color、gradient、rainbow、underline、none）。")))
      .addTextArea((t) => {
        t.setPlaceholder("claude-opus-5-5 = rainbow\n@gpt = underline")
          .setValue(
            Object.entries(s.modelStyle)
              .map(([k, v]) => `${k} = ${v}`)
              .join("\n"),
          )
          .onChange(async (v) => {
            s.modelStyle = {};
            for (const [k, style] of parseLines(v)) {
              if ((STYLES as readonly string[]).includes(style)) s.modelStyle[k] = style as StyleName;
            }
            await save();
          });
        t.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName(t("自定义家族前缀"))
      .then((row) => hint(row, t("每行一项：模型 ID 前缀 = 家族名，例如 ernie = ERNIE。")))
      .addTextArea((t) => {
        t.setPlaceholder("ernie = ERNIE")
          .setValue(s.extraPrefixes.map((e) => `${e.prefix} = ${e.label ?? e.family}`).join("\n"))
          .onChange(async (v) => {
            s.extraPrefixes = parseLines(v)
              .filter(([p, l]) => p && l)
              .map(([prefix, label]): ExtraPrefix => ({ prefix, family: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label }));
            await save();
          });
        t.inputEl.rows = 3;
      });

    new Setting(containerEl).setName(t("编辑")).setHeading();

    new Setting(containerEl)
      .setName(t("自动标注原创"))
      .then((row) => hint(row, t("在 AI 块与 &&…&& 内输入的文字自动包入 @@…@@。使用输入法时，停顿约 0.6 秒后才处理，组字过程中不改动文档。")))
      .addToggle((t) =>
        t.setValue(s.autoAnnotate).onChange(async (v) => {
          s.autoAnnotate = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName(t("复制时去除标记"))
      .then((row) => hint(row, t("剪贴板中的纯文本不含 && @@；在库内粘贴时，按落点重新写入标记。")))
      .addToggle((t) =>
        t.setValue(s.stripOnCopy).onChange(async (v) => {
          s.stripOnCopy = v;
          await save();
        }),
      );

    new Setting(containerEl).setName(t("搜索")).setHeading();

    new Setting(containerEl)
      .setName(t("搜索方式"))
      .then((row) =>
        hint(
          row,
          t("Obsidian 搜索栏：在搜索栏与笔记的查找栏（Ctrl+F）中加入「忽略格式」开关，依赖 Obsidian 的内部实现。Rakkan 搜索窗口：独立的搜索窗口，不改动 Obsidian。"),
        ),
      )
      .addDropdown((d) =>
        d
          .addOptions({ native: t("Obsidian 搜索栏"), window: t("Rakkan 搜索窗口") })
          .setValue(s.searchMode)
          .onChange(async (v) => {
            s.searchMode = v as RakkanSettings["searchMode"];
            await save();
            this.plugin.applySearch();
          }),
      );

    if (hasOmnisearch(this.app)) {
      new Setting(containerEl)
        .setName(t("兼容 Omnisearch"))
        .then((row) => hint(row, t("Omnisearch 可搜到被标记隔开的词，摘要中不显示标记。")))
        .addToggle((t) =>
          t.setValue(s.omnisearchCompat).onChange(async (v) => {
            s.omnisearchCompat = v;
            await save();
            this.plugin.applySearch();
          }),
        );
    }

    new Setting(containerEl).setName(t("署名簿")).setHeading();

    new Setting(containerEl)
      .setName(t("署名簿位置"))
      .then((row) => hint(row, t("库中的一篇笔记，每行一位作者：- @key: 名字 (标识) · 种类 · #颜色。种类为 人、AI 或 来源，颜色可省略。修改后自动重新读取。")))
      .addText((t) =>
        t.setValue(s.bookPath).onChange(async (v) => {
          s.bookPath = v.trim() || DEFAULT_SETTINGS.bookPath;
          await save();
          await this.plugin.reloadBook();
        }),
      )
      .addButton((b) =>
        b.setButtonText(t("新建")).onClick(async () => {
          await this.plugin.createBookNote();
        }),
      );

    new Setting(containerEl)
      .setName(t("默认署名"))
      .then((row) => hint(row, t("「标记为 AI 生成」将整段转为 AI 块时使用的署名，例如 Claude (claude-opus-5-5)。")))
      .addText((t) =>
        t.setValue(s.defaultSignature).onChange(async (v) => {
          s.defaultSignature = v.replace(/&&/g, "").trim() || "AI";
          await save();
        }),
      );
  }
}
