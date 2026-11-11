import { DEFAULT_PDF, type PdfOptions } from "./pdf";
import { App, getLanguage, PluginSettingTab, requireApiVersion, Setting } from "obsidian";
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

/**
 * One setting row. Obsidian 1.13+ renders it from getSettingDefinitions(),
 * which also feeds the settings search; older versions draw it in display().
 */
interface Row {
  name: string;
  desc?: string;
  visible?: () => boolean;
  render: (setting: Setting) => void;
}

interface Group {
  type: "group";
  heading: string;
  items: Row[];
}

const REPO_URL = "https://github.com/Kivisolipse/Rakkan";

/** A row whose explanation sits behind an info icon; the settings search still reads it. */
function row(name: string, desc: string | undefined, build: (setting: Setting) => unknown): Row {
  return {
    name,
    desc,
    render: (r) => {
      if (desc) hint(r.setDesc(""), desc);
      build(r);
    },
  };
}

export class RakkanSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: RakkanPlugin,
  ) {
    super(app, plugin);
  }

  /** Obsidian before 1.13 has no declarative settings and calls this instead. */
  override display(): void {
    this.draw();
  }

  private draw(): void {
    const { containerEl } = this;
    containerEl.empty();
    const add = (def: Row) => {
      if (def.visible?.() === false) return;
      def.render(new Setting(containerEl).setName(def.name).setDesc(def.desc ?? ""));
    };
    for (const item of this.getSettingDefinitions()) {
      if ("type" in item) {
        new Setting(containerEl).setName(item.heading).setHeading();
        item.items.forEach(add);
      } else add(item);
    }
  }

  /**
   * Rebuild the rows after a change that adds, removes or renames them.
   * Obsidian 1.13+ keeps the definitions until update() is called.
   */
  private refresh(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.draw();
  }

  override getSettingDefinitions(): Array<Row | Group> {
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
    };
    const styleOptions = Object.fromEntries(STYLES.map((k) => [k, styleLabels()[k]]));
    const families = [
      ...BUILTIN_FAMILIES,
      ...s.extraPrefixes.map((e) => ({ id: e.family, label: e.label ?? e.family })),
      { id: "generic", label: t("其他 AI") },
      { id: "quote", label: t("引用") },
    ].filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i);
    const authors = () => t("{n} 位作者", { n: Object.keys(this.plugin.authors).length });

    return [
      row(t("语言"), t("命令名称需重新加载插件后生效。"), (r) =>
        r.addDropdown((d) =>
          d
            .addOptions({ auto: t("跟随 Obsidian"), zh: "中文", en: "English" })
            .setValue(s.language)
            .onChange(async (v) => {
              s.language = v as Language;
              setLanguage(s.language, getLanguage());
              await save();
              this.refresh();
            }),
        ),
      ),

      {
        type: "group",
        heading: t("显示"),
        items: [
          row(t("显示模式"), t("写作：标记与颜色淡化；审阅：完整颜色。可为命令「切换写作 / 审阅显示」设置快捷键。"), (r) =>
            r.addDropdown((d) =>
              d
                .addOptions({ review: t("审阅"), writing: t("写作") })
                .setValue(s.mode)
                .onChange(async (v) => {
                  s.mode = v as RakkanSettings["mode"];
                  await save();
                }),
            ),
          ),
          row(t("实时预览隐藏标记"), t("光标不在该段时，隐藏 && @@ 与 [@key]，并隐藏块的开合行。"), (r) =>
            r.addToggle((t) =>
              t.setValue(s.hideMarkers).onChange(async (v) => {
                s.hideMarkers = v;
                await save();
              }),
            ),
          ),
          row(t("状态栏"), t("显示原创、AI、引用的比例及提醒。"), (r) =>
            r.addToggle((t) =>
              t.setValue(s.showStatusBar).onChange(async (v) => {
                s.showStatusBar = v;
                await save();
              }),
            ),
          ),
        ],
      },

      {
        type: "group",
        heading: t("样式"),
        items: [
          row(t("按模型家族上色"), t("关闭后，所有 AI 使用同一颜色。"), (r) =>
            r.addToggle((t) =>
              t.setValue(s.familyColors).onChange(async (v) => {
                s.familyColors = v;
                await save();
              }),
            ),
          ),
          row(t("AI 文字样式"), undefined, (r) =>
            r.addDropdown((d) =>
              d
                .addOptions(styleOptions)
                .setValue(s.aiStyle)
                .onChange(async (v) => {
                  s.aiStyle = v as StyleName;
                  await save();
                }),
            ),
          ),
          row(t("引用样式"), undefined, (r) =>
            r.addDropdown((d) =>
              d
                .addOptions(styleOptions)
                .setValue(s.quoteStyle)
                .onChange(async (v) => {
                  s.quoteStyle = v as StyleName;
                  await save();
                }),
            ),
          ),
          row(t("统一样式"), t("优先于下方所有按家族、按模型的设置。"), (r) =>
            r.addDropdown((d) =>
              d
                .addOptions({ "": t("不使用"), ...styleOptions })
                .setValue(s.forceStyle)
                .onChange(async (v) => {
                  s.forceStyle = v as StyleName | "";
                  await save();
                }),
            ),
          ),
        ],
      },

      {
        type: "group",
        heading: t("模型家族"),
        items: families.map((f): Row => {
          const ownStyle = f.id !== "quote" && f.id !== "generic";
          return {
            name: f.label,
            desc: t("前两项：浅色主题渐变起止色；后两项：深色主题渐变起止色") + (ownStyle ? t("；最右：该家族的样式") : ""),
            render: (r) => {
              const d = DEFAULT_COLORS[f.id] ?? DEFAULT_COLORS.generic;
              // A colour saved before there was a second one keeps its first as the second: one colour, as it was.
              const cur = (): Required<ColorPair> => {
                const own = s.colors[f.id];
                return own ? { light2: own.light, dark2: own.dark, ...own } : { ...d };
              };
              const picker = (which: keyof ColorPair) =>
                r.addColorPicker((c) => {
                  c.setValue(cur()[which]).onChange(async (v) => {
                    s.colors[f.id] = { ...cur(), [which]: v };
                    await save();
                  });
                });
              picker("light");
              picker("light2");
              picker("dark");
              picker("dark2");
              if (ownStyle) {
                r.addDropdown((dd) =>
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
              r.addExtraButton((b) =>
                b
                  .setIcon("rotate-ccw")
                  .setTooltip(t("恢复默认颜色"))
                  .onClick(async () => {
                    delete s.colors[f.id];
                    await save();
                    this.refresh();
                  }),
              );
            },
          };
        }),
      },

      {
        type: "group",
        heading: t("作者"),
        items: [
          {
            // The count changes outside this tab, so each render reads it afresh.
            name: authors(),
            render: (r) => {
              r.setName(authors())
                .addButton((btn) => btn.setButtonText(t("管理")).setCta().onClick(() => this.plugin.openAuthors()))
                .addButton((btn) => btn.setButtonText(t("打开署名簿")).onClick(() => void this.plugin.openBookNote()));
            },
          },
        ],
      },

      {
        type: "group",
        heading: t("颜色浓淡"),
        items: [
          row(t("写作模式颜色浓度"), t("0 为不着色，1 与审阅模式相同。"), (r) =>
            r.addSlider((sl) =>
              sl
                .setLimits(0, 1, 0.05)
                .setValue(s.writingStrength)
                .setDynamicTooltip()
                .onChange(async (v) => {
                  s.writingStrength = v;
                  await save();
                }),
            ),
          ),
          row(t("来源透明度"), t("无作者出处（书、网页）的显示浓淡，1 为不调暗。"), (r) =>
            r.addSlider((sl) =>
              sl
                .setLimits(0.2, 1, 0.05)
                .setValue(s.sourceOpacity)
                .setDynamicTooltip()
                .onChange(async (v) => {
                  s.sourceOpacity = v;
                  await save();
                }),
            ),
          ),
          row(t("按模型指定样式"), t("每行一项：模型 ID 或 @key = 样式（color、gradient、rainbow、underline、none）。"), (r) =>
            r.addTextArea((t) => {
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
            }),
          ),
          row(t("自定义家族前缀"), t("每行一项：模型 ID 前缀 = 家族名，例如 ernie = ERNIE。"), (r) =>
            r.addTextArea((t) => {
              t.setPlaceholder("ernie = ERNIE")
                .setValue(s.extraPrefixes.map((e) => `${e.prefix} = ${e.label ?? e.family}`).join("\n"))
                .onChange(async (v) => {
                  s.extraPrefixes = parseLines(v)
                    .filter(([p, l]) => p && l)
                    .map(([prefix, label]): ExtraPrefix => ({ prefix, family: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label }));
                  await save();
                });
              t.inputEl.rows = 3;
              // Families added here get their colour rows once the box loses focus.
              t.inputEl.addEventListener("change", () => this.refresh());
            }),
          ),
        ],
      },

      {
        type: "group",
        heading: t("编辑"),
        items: [
          row(t("自动标注原创"), t("在 AI 块与 &&…&& 内输入的文字自动包入 @@…@@。使用输入法时，停顿约 0.6 秒后才处理，组字过程中不改动文档。"), (r) =>
            r.addToggle((t) =>
              t.setValue(s.autoAnnotate).onChange(async (v) => {
                s.autoAnnotate = v;
                await save();
              }),
            ),
          ),
          row(t("复制时去除标记"), t("剪贴板中的纯文本不含 && @@；在库内粘贴时，按落点重新写入标记。"), (r) =>
            r.addToggle((t) =>
              t.setValue(s.stripOnCopy).onChange(async (v) => {
                s.stripOnCopy = v;
                await save();
              }),
            ),
          ),
        ],
      },

      {
        type: "group",
        heading: t("搜索"),
        items: [
          row(
            t("搜索方式"),
            t("Obsidian 搜索栏：在搜索栏与笔记的查找栏（Ctrl+F）中加入「忽略格式」开关，依赖 Obsidian 的内部实现。Rakkan 搜索窗口：独立的搜索窗口，不改动 Obsidian。"),
            (r) =>
              r.addDropdown((d) =>
                d
                  .addOptions({ native: t("Obsidian 搜索栏"), window: t("Rakkan 搜索窗口") })
                  .setValue(s.searchMode)
                  .onChange(async (v) => {
                    s.searchMode = v as RakkanSettings["searchMode"];
                    await save();
                    this.plugin.applySearch();
                  }),
              ),
          ),
          {
            ...row(t("兼容 Omnisearch"), t("Omnisearch 可搜到被标记隔开的词，摘要中不显示标记。"), (r) =>
              r.addToggle((t) =>
                t.setValue(s.omnisearchCompat).onChange(async (v) => {
                  s.omnisearchCompat = v;
                  await save();
                  this.plugin.applySearch();
                }),
              ),
            ),
            visible: () => hasOmnisearch(this.app),
          },
        ],
      },

      {
        type: "group",
        heading: t("署名簿"),
        items: [
          row(t("署名簿位置"), t("库中的一篇笔记，每行一位作者：- @key: 名字 (标识) · 种类 · #颜色。种类为 人、AI 或 来源，颜色可省略。修改后自动重新读取。"), (r) =>
            r
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
              ),
          ),
          row(t("默认署名"), t("「标记为 AI 生成」将整段转为 AI 块时使用的署名，例如 Claude (claude-opus-5-5)。"), (r) =>
            r.addText((t) =>
              t.setValue(s.defaultSignature).onChange(async (v) => {
                s.defaultSignature = v.replace(/&&/g, "").trim() || "AI";
                await save();
              }),
            ),
          ),
        ],
      },

      {
        type: "group",
        heading: t("停用与卸载"),
        items: [
          row(
            t("从整个库中移除标记"),
            t("将库中的笔记改写为不含 Rakkan 语法的 Markdown，供停用插件前使用。标记位置另存于库根目录的 rakkan-authorship.json，之后可以恢复；移除后修改过的笔记无法恢复。仅卸载插件不会修改任何笔记。"),
            (r) => r.addButton((b) => b.setButtonText(t("移除全部标记…")).setWarning().onClick(() => this.plugin.openStripVault())),
          ),
          row(
            t("从署名存档恢复标记"),
            t("按库根目录的 rakkan-authorship.json，为移除后未经修改的笔记恢复原有标记。"),
            (r) => r.addButton((b) => b.setButtonText(t("恢复…")).onClick(() => this.plugin.openRestoreArchive())),
          ),
        ],
      },

      {
        type: "group",
        heading: t("关于"),
        items: [
          {
            name: t("源代码与问题反馈"),
            desc: t("如果 Rakkan 对你有用，欢迎在 GitHub 上点个 Star。"),
            render: (r) => r.addButton((b) => b.setButtonText("GitHub").onClick(() => window.open(REPO_URL))),
          },
        ],
      },
    ];
  }
}
