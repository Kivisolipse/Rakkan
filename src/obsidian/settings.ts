import { App, PluginSettingTab, Setting } from "obsidian";
import { BUILTIN_FAMILIES, type ExtraPrefix } from "../core";
import { STYLES, type StyleName, type StyleSettings } from "../cm6/resolve";
import type RakkanPlugin from "../main";
import { DEFAULT_COLORS, type ColorPair } from "../cm6/colors";


export interface RakkanSettings extends StyleSettings {
  /** Hide markers away from the cursor in live preview. */
  hideMarkers: boolean;
  mode: "writing" | "review";
  stripOnCopy: boolean;
  searchIgnoreFormat: boolean;
  showStatusBar: boolean;
  /** Signature used when "mark as AI" creates a block. */
  defaultSignature: string;
  /** Per family id, plus "generic" and "quote". Missing entries use the defaults. */
  colors: Record<string, ColorPair>;
}


export const DEFAULT_SETTINGS: RakkanSettings = {
  familyColors: true,
  aiStyle: "gradient",
  quoteStyle: "underline",
  familyStyle: {},
  modelStyle: {},
  forceStyle: "",
  extraPrefixes: [],
  hideMarkers: true,
  mode: "review",
  stripOnCopy: true,
  searchIgnoreFormat: true,
  showStatusBar: true,
  defaultSignature: "AI",
  colors: {},
};

const STYLE_LABELS: Record<StyleName, string> = {
  gradient: "渐变底色",
  solid: "纯色底色",
  rainbow: "彩虹字",
  underline: "下划线",
  leftline: "左边一条线",
  none: "关闭",
};

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

    new Setting(containerEl).setName("显示").setHeading();

    new Setting(containerEl)
      .setName("显示模式")
      .setDesc("写作：标记和颜色都很淡；审阅：全彩。可以给命令「切换写作 / 审阅显示」设快捷键。")
      .addDropdown((d) =>
        d
          .addOptions({ review: "审阅", writing: "写作" })
          .setValue(s.mode)
          .onChange(async (v) => {
            s.mode = v as RakkanSettings["mode"];
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("实时预览里藏起标记")
      .setDesc("光标不在那一段时，藏起 && @@ 和 [@key]，块的开合行显示成署名签。")
      .addToggle((t) =>
        t.setValue(s.hideMarkers).onChange(async (v) => {
          s.hideMarkers = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("状态栏")
      .setDesc("显示「亲笔 · 代笔 · 引文」比例和提醒。")
      .addToggle((t) =>
        t.setValue(s.showStatusBar).onChange(async (v) => {
          s.showStatusBar = v;
          await save();
        }),
      );

    new Setting(containerEl).setName("样式").setHeading();

    const styleOptions = Object.fromEntries(STYLES.map((k) => [k, STYLE_LABELS[k]]));

    new Setting(containerEl)
      .setName("按模型家族上色")
      .setDesc("关掉以后所有 AI 用同一个颜色。")
      .addToggle((t) =>
        t.setValue(s.familyColors).onChange(async (v) => {
          s.familyColors = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("AI 文字的样式")
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
      .setName("引文的样式")
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
      .setName("总开关：全部用同一种样式")
      .setDesc("盖过下面所有按家族、按模型的设置。")
      .addDropdown((d) =>
        d
          .addOptions({ "": "不使用", ...styleOptions })
          .setValue(s.forceStyle)
          .onChange(async (v) => {
            s.forceStyle = v as StyleName | "";
            await save();
          }),
      );

    new Setting(containerEl).setName("模型家族").setHeading();

    const families = [
      ...BUILTIN_FAMILIES,
      ...s.extraPrefixes.map((e) => ({ id: e.family, label: e.label ?? e.family })),
      { id: "generic", label: "其他 AI" },
      { id: "quote", label: "引文" },
    ].filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i);

    for (const f of families) {
      const d = DEFAULT_COLORS[f.id] ?? DEFAULT_COLORS.generic;
      const cur = () => s.colors[f.id] ?? { light: d.light, dark: d.dark };
      const row = new Setting(containerEl).setName(f.label);
      row.addColorPicker((c) =>
        c
          .setValue(cur().light)
          .onChange(async (v) => {
            s.colors[f.id] = { ...cur(), light: v };
            await save();
          }),
      );
      row.addColorPicker((c) =>
        c
          .setValue(cur().dark)
          .onChange(async (v) => {
            s.colors[f.id] = { ...cur(), dark: v };
            await save();
          }),
      );
      if (f.id !== "quote" && f.id !== "generic") {
        row.addDropdown((dd) =>
          dd
            .addOptions({ "": "跟随默认", ...styleOptions })
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
          .setTooltip("恢复默认颜色")
          .onClick(async () => {
            delete s.colors[f.id];
            await save();
            this.display();
          }),
      );
      row.descEl.setText("浅色 · 深色" + (f.id !== "quote" && f.id !== "generic" ? " · 样式" : ""));
    }

    new Setting(containerEl)
      .setName("按具体模型换样式")
      .setDesc("一行一个：模型 ID 或 @key = 样式（gradient、solid、rainbow、underline、leftline、none）。")
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
      .setName("自定义家族前缀")
      .setDesc("一行一个：模型 ID 前缀 = 家族名。比如 ernie = ERNIE。")
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

    new Setting(containerEl).setName("编辑").setHeading();

    new Setting(containerEl)
      .setName("复制时去掉标记")
      .setDesc("剪贴板里的纯文本不带 && @@；在库里粘贴时按落点重新写好标记。")
      .addToggle((t) =>
        t.setValue(s.stripOnCopy).onChange(async (v) => {
          s.stripOnCopy = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("搜索时忽略格式")
      .setDesc("「搜索（忽略格式）」命令默认打开这个开关，搜索框里也能切换。")
      .addToggle((t) =>
        t.setValue(s.searchIgnoreFormat).onChange(async (v) => {
          s.searchIgnoreFormat = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("默认署名")
      .setDesc("「标为代笔」把整段变成 AI 块时用的署名，比如 Claude (claude-opus-5-5)。")
      .addText((t) =>
        t.setValue(s.defaultSignature).onChange(async (v) => {
          s.defaultSignature = v.replace(/&&/g, "").trim() || "AI";
          await save();
        }),
      );
  }
}
