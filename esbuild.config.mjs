import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian ships its own copies; bundling a second CodeMirror breaks the editor.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  // The rakkan command, bundled into the agent skill so that it runs without an install.
  await esbuild.build({
    entryPoints: ["cli/rakkan.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    banner: { js: "#!/usr/bin/env node\n// Built by `npm run build` from cli/rakkan.ts; edit that instead." },
    logLevel: "info",
    outfile: "skills/rakkan/scripts/rakkan.mjs",
  });
  process.exit(0);
} else {
  await context.watch();
}
